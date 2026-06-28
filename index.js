const express = require('express');
const cors = require('cors');
const sinesp = require('sinesp-api');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', servico: 'Auto Center - Consulta de Placa' });
});

app.get('/placa/:placa', async (req, res) => {
  const placa = (req.params.placa || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (placa.length < 7) {
    return res.status(400).json({ error: 'Placa invalida.' });
  }
  try {
    console.log('Consultando placa:', placa);
    const data = await sinesp.search(placa);
    if (!data || data.codigoRetorno !== '0') {
      return res.status(404).json({ error: data?.mensagemRetorno || 'Veiculo nao encontrado.' });
    }
    res.json({
      marca:     (data.marca     || '').trim(),
      modelo:    (data.modelo    || '').trim(),
      ano:       (data.anoModelo || data.ano || '').toString().trim(),
      cor:       (data.cor       || '').trim(),
      uf:        (data.uf        || '').trim(),
      municipio: (data.municipio || '').trim(),
      situacao:  (data.situacao  || '').trim(),
      placa:     placa
    });
  } catch (e) {
    console.error('Erro:', e.message);
    res.status(400).json({ error: 'Erro ao consultar: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API rodando na porta', PORT));
