const express = require('express');
const cors = require('cors');
const sinesp = require('sinesp-api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Auto Center API v6' });
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
      marca: (data.marca || '').trim(), modelo: (data.modelo || '').trim(),
      ano: String(data.anoModelo || data.ano || '').trim(), cor: (data.cor || '').trim(), placa
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Busca NF-e pela chave de acesso via Meu Danfe API v2
app.get('/buscar-nf/:chave', async (req, res) => {
  const chave = (req.params.chave || '').replace(/[^0-9]/g, '');
  if (chave.length !== 44) return res.status(400).json({ error: 'Chave invalida (44 digitos).' });

  const apiKey = process.env.MEUDANFE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MEUDANFE_KEY nao configurada.' });

  const BASE = 'https://api.meudanfe.com.br/v2';
  // Header correto conforme documentacao: Api-Key
  const hdrs = { 'Api-Key': apiKey, 'Accept': 'application/json' };

  try {
    // Passo 1: PUT /fd/add/{chave} - solicita busca na Receita (R$0,03 se nova)
    console.log('[NF] PUT /fd/add/' + chave.slice(0,10) + '...');
    let r = await fetch(`${BASE}/fd/add/${chave}`, {
      method: 'PUT', headers: hdrs, signal: AbortSignal.timeout(20000)
    });
    let json = await r.json();
    console.log('[NF] PUT status HTTP:', r.status, '| status NF:', json.status, '|', json.statusMessage);

    // Tratar erros HTTP
    if (r.status === 400) return res.status(400).json({ error: 'Chave de acesso invalida (400).' });
    if (r.status === 401) return res.status(401).json({ error: 'Api-Key invalida ou nao informada (401).' });
    if (r.status === 402) return res.status(402).json({ error: 'Saldo insuficiente no Meu Danfe. Acesse web.meudanfe.com.br para recarregar.' });
    if (r.status === 403) return res.status(403).json({ error: 'Api-Key foi substituida. Gere uma nova em web.meudanfe.com.br.' });
    if (!r.ok) return res.status(r.status).json({ error: json.statusMessage || 'Erro na API Meu Danfe' });

    // Polling: aguarda status OK (WAITING -> SEARCHING -> OK/NOT_FOUND/ERROR)
    let status = json.status;
    let tentativas = 0;
    while ((status === 'WAITING' || status === 'SEARCHING') && tentativas < 12) {
      await sleep(1500); // espera minimo 1s conforme documentacao
      tentativas++;
      console.log(`[NF] Polling tentativa ${tentativas} - status atual: ${status}`);
      r = await fetch(`${BASE}/fd/add/${chave}`, {
        method: 'PUT', headers: hdrs, signal: AbortSignal.timeout(20000)
      });
      json = await r.json();
      status = json.status;
      console.log('[NF] Polling status:', status, '|', json.statusMessage);
    }

    if (status === 'NOT_FOUND') return res.status(404).json({ error: 'NF-e nao encontrada na Receita Federal.' });
    if (status === 'ERROR') return res.status(500).json({ error: 'Erro ao buscar NF-e: ' + (json.statusMessage || '') });
    if (status !== 'OK') return res.status(500).json({ error: 'Status inesperado apos polling: ' + status });

    // Passo 2: GET /fd/get/xml/{chave} - baixa o XML (gratis)
    console.log('[NF] GET /fd/get/xml/' + chave.slice(0,10) + '...');
    const r2 = await fetch(`${BASE}/fd/get/xml/${chave}`, {
      method: 'GET',
      headers: { 'Api-Key': apiKey, 'Accept': 'text/xml, application/xml, */*' },
      signal: AbortSignal.timeout(15000)
    });
    const xmlText = await r2.text();
    console.log('[NF] GET XML status:', r2.status, '| inicio:', xmlText.slice(0, 60));

    if (!r2.ok) return res.status(r2.status).json({ error: 'Erro ao baixar XML: ' + xmlText.slice(0, 200) });

    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.send(xmlText);

  } catch (e) {
    console.error('[NF] Excecao:', e.message);
    if (e.name === 'TimeoutError') return res.status(504).json({ error: 'Timeout - tente novamente em alguns segundos.' });
    res.status(500).json({ error: e.message });
  }
});

// Proxy Claude Vision para leitura de NF por foto/PDF
app.post('/ler-nf', async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64 || !mimeType) return res.status(400).json({ error: 'base64 e mimeType obrigatorios' });
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_KEY nao configurada' });
  const isPDF = mimeType === 'application/pdf';
  const content = isPDF
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: 'Extraia produtos/pecas desta NF. Para cada item: descricao, quantidade (numero), precoUnitario (numero). Apenas array JSON, sem markdown.' }]
    : [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }, { type: 'text', text: 'Extraia produtos/pecas desta NF. Para cada item: descricao, quantidade (numero), precoUnitario (numero). Apenas array JSON, sem markdown.' }];
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
  } catch (e) { res.status(500).json({ error: 'Erro: ' + e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API v6 rodando na porta', PORT));
