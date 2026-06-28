const express = require('express');
const cors = require('cors');
const sinesp = require('sinesp-api');

const app = express();
app.use(cors());
app.use(express.json());

// Wrapper com timeout de 12 segundos
function buscarComTimeout(placa) {
  return Promise.race([
    sinesp.search(placa),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SINESP nao respondeu em 12s - servico instavel')), 12000)
    )
  ]);
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Auto Center - Consulta de Placa v2' });
});

app.get('/placa/:placa', async (req, res) => {
  const placa = (req.params.placa || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  if (placa.length < 7) {
    return res.status(400).json({ error: 'Placa invalida.' });
  }

  try {
    console.log('[CONSULTA] Placa:', placa);
    const data = await buscarComTimeout(placa);
    console.log('[RESPOSTA] Raw:', JSON.stringify(data));

    if (!data) {
      return res.status(404).json({ error: 'SINESP retornou vazio' });
    }

    if (data.codigoRetorno && data.codigoRetorno !== '0') {
      console.log('[ERRO SINESP]', data.codigoRetorno, data.mensagemRetorno);
      return res.status(404).json({ error: data.mensagemRetorno || 'Veiculo nao encontrado' });
    }

    const resultado = {
      marca:     (data.marca     || '').trim(),
      modelo:    (data.modelo    || '').trim(),
      ano:       (data.anoModelo || data.ano || '').toString().trim(),
      cor:       (data.cor       || '').trim(),
      uf:        (data.uf        || '').trim(),
      municipio: (data.municipio || '').trim(),
      situacao:  (data.situacao  || '').trim(),
      placa:     placa
    };

    console.log('[OK]', resultado.marca, resultado.modelo, resultado.ano);
    res.json(resultado);

  } catch (e) {
    console.error('[ERRO]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API v2 rodando na porta', PORT));
