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

// Busca NF-e pela chave de acesso via Meu Danfe API v2
// Passo 1: PUT /fd/add/{chave} - adiciona na conta (R$0,03)
// Passo 2: GET /fd/get/xml/{chave} - baixa o XML (gratis)
app.get('/buscar-nf/:chave', async (req, res) => {
  const chave = (req.params.chave || '').replace(/[^0-9]/g, '');
  if (chave.length !== 44) return res.status(400).json({ error: 'Chave invalida (deve ter 44 digitos).' });

  const apiKey = process.env.MEUDANFE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'MEUDANFE_KEY nao configurada no servidor.' });

  const BASE = 'https://api.meudanfe.com.br/v2';
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/xml, application/xml, */*'
  };

  try {
    // Passo 1: adicionar/buscar NF-e pela chave (cobra R$0,03 se nao estiver na conta)
    console.log('[NF] Passo 1 - PUT /fd/add/' + chave.slice(0,10) + '...');
    const r1 = await fetch(`${BASE}/fd/add/${chave}`, {
      method: 'PUT',
      headers,
      signal: AbortSignal.timeout(20000)
    });
    const t1 = await r1.text();
    console.log('[NF] Passo 1 status:', r1.status, '| resp:', t1.slice(0, 120));

    if (!r1.ok && r1.status !== 409) {
      // 409 = ja existe na conta (tudo certo, pode ir para o passo 2)
      let msg = t1;
      try { msg = JSON.parse(t1).message || JSON.parse(t1).error || t1; } catch {}
      return res.status(r1.status).json({ error: 'Erro ao adicionar NF-e: ' + msg });
    }

    // Passo 2: baixar o XML (gratis)
    console.log('[NF] Passo 2 - GET /fd/get/xml/' + chave.slice(0,10) + '...');
    const r2 = await fetch(`${BASE}/fd/get/xml/${chave}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000)
    });
    const t2 = await r2.text();
    console.log('[NF] Passo 2 status:', r2.status, '| inicio:', t2.slice(0, 80));

    if (!r2.ok) {
      let msg = t2;
      try { msg = JSON.parse(t2).message || JSON.parse(t2).error || t2; } catch {}
      return res.status(r2.status).json({ error: 'Erro ao baixar XML: ' + msg });
    }

    // Retornou XML direto
    if (t2.trim().startsWith('<')) {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      return res.send(t2);
    }

    // Retornou JSON com XML ou base64 dentro
    try {
      const json = JSON.parse(t2);
      const xml = json.xml || json.xmlNFe || json.conteudo || json.data;
      if (xml && String(xml).trim().startsWith('<')) {
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(xml);
      }
      // Pode estar em base64
      if (xml) {
        try {
          const decoded = Buffer.from(xml, 'base64').toString('utf-8');
          if (decoded.trim().startsWith('<')) {
            res.set('Content-Type', 'application/xml; charset=utf-8');
            return res.send(decoded);
          }
        } catch {}
      }
      return res.status(400).json({ error: 'Formato inesperado', detalhe: t2.slice(0, 300) });
    } catch {
      return res.status(400).json({ error: 'Resposta invalida do servidor', detalhe: t2.slice(0, 300) });
    }

  } catch (e) {
    console.error('[NF] Erro:', e.message);
    if (e.name === 'TimeoutError') return res.status(504).json({ error: 'Timeout (20s) - tente novamente' });
    res.status(500).json({ error: e.message });
  }
});

// Proxy Claude Vision para leitura de NF por foto/PDF
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
