const express = require('express');
const cors = require('cors');
const sinesp = require('sinesp-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Auto Center API v5' });
});

// Consulta de placa via SINESP
app.get('/placa/:placa', async (req, res) => {
  const placa = (req.params.placa || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (placa.length < 7) return res.status(400).json({ error: 'Placa invalida.' });
  try {
    const data = await Promise.race([
      sinesp.search(placa),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout SINESP')), 12000))
    ]);
    if (!data || data.codigoRetorno !== '0')
      return res.status(404).json({ error: data?.mensagemRetorno || 'Veiculo nao encontrado' });
    res.json({
      marca: (data.marca || '').trim(),
      modelo: (data.modelo || '').trim(),
      ano: String(data.anoModelo || data.ano || '').trim(),
      cor: (data.cor || '').trim(),
      placa
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Busca NF-e pela chave de acesso - tenta varios formatos de endpoint
app.get('/buscar-nf/:chave', async (req, res) => {
  const chave = (req.params.chave || '').replace(/[^0-9]/g, '');
  if (chave.length !== 44) return res.status(400).json({ error: 'Chave invalida (deve ter 44 digitos).' });

  const apiKey = process.env.MEUDANFE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MEUDANFE_KEY nao configurada.' });

  // Endpoints para tentar em ordem
  const tentativas = [
    // Formato 1: POST com chave no body (texto)
    { method: 'POST', url: `https://ws.meudanfe.com/api/v1/get/nfe/chave/${apiKey}`, body: chave, ct: 'text/plain' },
    // Formato 2: POST com JSON
    { method: 'POST', url: `https://ws.meudanfe.com/api/v1/get/nfe/${apiKey}`, body: JSON.stringify({ chave }), ct: 'application/json' },
    // Formato 3: GET com chave na URL
    { method: 'GET', url: `https://ws.meudanfe.com/api/v1/get/nfe/xml/${apiKey}/${chave}`, body: null, ct: null },
    // Formato 4: POST corpo chave
    { method: 'POST', url: `https://ws.meudanfe.com/api/v1/nfe/chave/${apiKey}`, body: chave, ct: 'text/plain' },
  ];

  let ultimoErro = '';
  for (const t of tentativas) {
    try {
      const opts = { method: t.method, headers: { Accept: 'text/xml,application/xml,application/json,*/*' }, signal: AbortSignal.timeout(12000) };
      if (t.body) { opts.body = t.body; opts.headers['Content-Type'] = t.ct; }
      console.log(`[NF] Tentando: ${t.method} ${t.url}`);
      const r = await fetch(t.url, opts);
      const text = await r.text();
      console.log(`[NF] Status: ${r.status} | Resposta: ${text.slice(0, 100)}`);

      if (!r.ok) { ultimoErro = `${r.status}: ${text.slice(0, 150)}`; continue; }

      // Retornou XML
      if (text.trim().startsWith('<')) {
        res.set('Content-Type', 'application/xml');
        return res.send(text);
      }
      // Retornou JSON com XML dentro
      try {
        const json = JSON.parse(text);
        const xml = json.xml || json.nfe?.xml || json.xmlNFe || json.data?.xml || json.conteudo;
        if (xml && xml.trim().startsWith('<')) {
          res.set('Content-Type', 'application/xml');
          return res.send(xml);
        }
        // JSON sem XML - pode ser resposta de sucesso com dados
        if (json.error || json.mensagem) { ultimoErro = json.error || json.mensagem; continue; }
        return res.json(json);
      } catch {
        ultimoErro = `Resposta inesperada: ${text.slice(0, 150)}`;
        continue;
      }
    } catch (e) {
      ultimoErro = e.message;
      console.log(`[NF] Erro na tentativa: ${e.message}`);
    }
  }

  // Nenhuma funcionou - retorna erro detalhado para debug
  res.status(400).json({
    error: 'Nenhum endpoint funcionou. Ultimo erro: ' + ultimoErro,
    dica: 'Verifique a documentacao da API em web.meudanfe.com.br e informe o endpoint correto.'
  });
});

// Proxy Claude Vision
app.post('/ler-nf', async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64 || !mimeType) return res.status(400).json({ error: 'base64 e mimeType sao obrigatorios' });
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY nao configurada' });
  const isPDF = mimeType === 'application/pdf';
  const content = isPDF
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: 'Extraia todos os produtos/pecas desta NF. Para cada item: descricao, quantidade (numero), precoUnitario (numero). Apenas array JSON, sem markdown.' }]
    : [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }, { type: 'text', text: 'Extraia todos os produtos/pecas desta NF. Para cada item: descricao, quantidade (numero), precoUnitario (numero). Apenas array JSON, sem markdown.' }];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content }] })
    });
    const json = await r.json();
    if (!r.ok) return res.status(500).json({ error: json.error?.message || 'Erro API Claude' });
    const txt = (json.content || []).map(x => x.text || '').join('').replace(/```json|```/g, '').trim();
    res.json({ items: JSON.parse(txt) });
  } catch (e) {
    res.status(500).json({ error: 'Erro: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API v5 rodando na porta', PORT));
