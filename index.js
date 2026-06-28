const express = require('express');
const cors = require('cors');
const sinesp = require('sinesp-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Auto Center API v4' });
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
      uf: (data.uf || '').trim(),
      municipio: (data.municipio || '').trim(),
      situacao: (data.situacao || '').trim(),
      placa
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Busca NF-e pela chave de acesso via Meu Danfe
app.get('/buscar-nf/:chave', async (req, res) => {
  const chave = (req.params.chave || '').replace(/[^0-9]/g, '');
  if (chave.length !== 44) return res.status(400).json({ error: 'Chave de acesso invalida (deve ter 44 digitos).' });

  const apiKey = process.env.MEUDANFE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MEUDANFE_KEY nao configurada no servidor.' });

  try {
    console.log('[NF] Buscando chave:', chave.slice(0, 10) + '...');

    // Endpoint do Meu Danfe: GET /api/v1/get/nfe/{chave}/{apikey}
    const url = `https://ws.meudanfe.com/api/v1/get/nfe/${chave}/${apiKey}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'text/xml,application/xml,*/*' },
      signal: AbortSignal.timeout(15000)
    });

    const text = await r.text();
    console.log('[NF] Status:', r.status, '| Inicio resposta:', text.slice(0, 80));

    if (!r.ok) {
      // Tenta JSON de erro
      try {
        const err = JSON.parse(text);
        return res.status(r.status).json({ error: err.message || err.error || text });
      } catch {
        return res.status(r.status).json({ error: text || 'Erro na API Meu Danfe' });
      }
    }

    // Verifica se retornou XML ou JSON com XML dentro
    if (text.trim().startsWith('<')) {
      // Retornou XML direto
      res.set('Content-Type', 'application/xml');
      return res.send(text);
    }

    // Tenta parsear como JSON
    try {
      const json = JSON.parse(text);
      // Meu Danfe pode retornar { xml: '...' } ou { nfe: { xml: '...' } }
      const xml = json.xml || json.nfe?.xml || json.xmlNFe || json.data?.xml;
      if (xml) {
        res.set('Content-Type', 'application/xml');
        return res.send(xml);
      }
      return res.status(400).json({ error: 'Resposta inesperada da API', detalhe: text.slice(0, 200) });
    } catch {
      return res.status(400).json({ error: 'Formato de resposta desconhecido', detalhe: text.slice(0, 200) });
    }

  } catch (e) {
    console.error('[NF] Erro:', e.message);
    if (e.name === 'TimeoutError') return res.status(504).json({ error: 'Timeout ao consultar Meu Danfe (15s)' });
    res.status(500).json({ error: e.message });
  }
});

// Proxy Claude Vision para leitura de NF por foto/PDF
app.post('/ler-nf', async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64 || !mimeType) return res.status(400).json({ error: 'base64 e mimeType sao obrigatorios' });

  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY nao configurada no servidor' });

  const isPDF = mimeType === 'application/pdf';
  const content = isPDF
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'Leia esta nota fiscal e extraia todos os produtos/pecas. Para cada item retorne: descricao, quantidade (numero), precoUnitario (numero). Ignore servicos, frete, desconto. Responda APENAS com array JSON valido, sem markdown.' }
      ]
    : [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Leia esta nota fiscal e extraia todos os produtos/pecas. Para cada item retorne: descricao, quantidade (numero), precoUnitario (numero). Ignore servicos, frete, desconto. Responda APENAS com array JSON valido, sem markdown.' }
      ];

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
    res.status(500).json({ error: 'Erro ao processar imagem: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API v4 rodando na porta', PORT));
