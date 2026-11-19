# Histórico de versões

## 2.0.0

### Adicionado
- Seleção de talhões importados (`ee.Geometry`, `ee.Feature`, `ee.FeatureCollection`), com lista, filtro por nome e clique no mapa.
- Suavização visual com os modos *Desativada*, *Suave* (bilinear) e *Intensificada* (bicúbica), aplicada somente à exibição.
- Indicador de consultas em andamento.
- Retomada de séries temporais a partir do último lote concluído.

### Alterado
- Validação do talhão antes da troca: uma geometria inválida não descarta a análise em andamento.
- Escala de cores dos índices pelos percentis 2–98, com mínimo e máximo reais na legenda.
- Fila de consultas com uma vaga reservada à interface e lotes maiores nas séries.
- Desenho manual passa a ser um recurso opcional.

### Corrigido
- Reduções estatísticas passam a usar a grade nativa da cena (`crs` com a própria projeção).
- Critério único de NDVI válido no cartão de classes e na série temporal.
- Talhões vindos de coleções deixam de ser enviados às ferramentas de desenho.

## 1.0.0

- Versão inicial: pesquisa Sentinel-2, índices espectrais, classes de NDVI, comparação de datas e clima ERA5-Land.
