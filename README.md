# Monitoramento Agrícola · Google Earth Engine

![Plataforma](https://img.shields.io/badge/plataforma-Google%20Earth%20Engine-4285F4)
![Linguagem](https://img.shields.io/badge/JavaScript-ES5-F7DF1E)
![Sentinel-2](https://img.shields.io/badge/imagens-Sentinel--2%20SR-2E7D32)
![ERA5-Land](https://img.shields.io/badge/clima-ERA5--Land-0277BD)

Aplicação interativa para o monitoramento de talhões agrícolas com imagens de satélite reais. Permite selecionar um talhão, consultar as cenas Sentinel-2 disponíveis, visualizar índices de vegetação, comparar datas lado a lado e acompanhar a evolução da lavoura junto a dados de temperatura e precipitação.

Executa diretamente no **Google Earth Engine Code Editor**, sem instalação.

---

## Funcionalidades

| Área | Recursos |
|---|---|
| **Talhões** | Seleção dos talhões importados (`ee.Geometry`, `ee.Feature`, `ee.FeatureCollection`) por lista, filtro por nome ou clique no mapa · área em hectares · desenho manual opcional |
| **Imagens** | Pesquisa por período (30, 90, 180 ou 365 dias, ou datas livres) · listagem paginada das cenas · RGB e índices NDVI, NDWI, NDMI, EVI e SAVI |
| **Comparação** | Dois mapas sincronizados com cortina deslizante ou quadros lado a lado · cena, índice e camadas independentes em cada lado |
| **Estatísticas** | Distribuição do NDVI em cinco classes · área válida · média ponderada por área |
| **Séries temporais** | Média espacial do índice escolhido em todas as cenas do período · temperatura e precipitação diárias (ERA5-Land) |
| **Visualização** | Suavização visual opcional · escala de cores automática por cena · legendas com unidades e resolução |

## Primeiros passos

1. Abra o [Code Editor](https://code.earthengine.google.com) e crie um novo script.
2. Cole o conteúdo de [`monitoramento-agricola.js`](monitoramento-agricola.js).
3. Importe os talhões, por um destes caminhos:
   - desenhe polígonos com as ferramentas do mapa (variáveis `geometry`, `geometry2`, …);
   - importe uma tabela ou asset com os limites (variáveis `table`, `table2`, …).
4. Clique em **Run** e depois em **Selecionar talhão importado**.

### Registro de imports com outros nomes

O Code Editor não oferece API para listar o painel *Imports*. Por isso, os talhões são lidos de um registro explícito no início do script. Os nomes padrão já estão incluídos. Para uma variável com outro nome, acrescente uma linha:

```js
var TALHOES_IMPORTADOS = [
  // ...
  {nome: 'Fazenda Boa Vista',
   obter: function () { return typeof fazendaBoaVista !== 'undefined' ? fazendaBoaVista : null; },
   campoNome: 'NOME'}   // opcional: atributo com o nome de cada talhão
];
```

Sem `campoNome`, o nome é procurado em atributos comuns (`nome`, `name`, `talhao`, `id`, `codigo`…) e, por último, em `system:index`.

## Controles

| Controle | Local | Função |
|---|---|---|
| **Selecionar talhão importado** | Barra de status | Abre o painel de talhões: fonte, filtro, lista e clique no mapa |
| **Período** | Cabeçalho | Datas inclusivas ou atalhos de 30 a 365 dias |
| **Suavização visual** | Cabeçalho | *Desativada* (pixels nativos), *Suave* (bilinear) ou *Intensificada* (bicúbica) |
| **Barra lateral** | Mapa esquerdo | Navegar · talhões · gráficos · camadas · cortina/quadros |
| **Série temporal e clima** | Abaixo do cabeçalho | Abre os gráficos; **Atualizar dados** retoma séries interrompidas |
| **− / +** | Cartões | Recolhem ou expandem painéis |

## Metodologia

### Índices espectrais

Refletância de superfície = valor digital × 0,0001 (`S2_SR_HARMONIZED`).

| Índice | Fórmula | Bandas | Resolução |
|---|---|---|---|
| NDVI | (NIR − Red) / (NIR + Red) | B8, B4 | 10 m |
| NDWI | (Green − NIR) / (Green + NIR) | B3, B8 | 10 m |
| NDMI | (NIR − SWIR1) / (NIR + SWIR1) | B8 agregada por média, B11 | 20 m |
| EVI | 2,5 (NIR − Red) / (NIR + 6 Red − 7,5 Blue + 1) | B8, B4, B2 | 10 m |
| SAVI | 1,5 (NIR − Red) / (NIR + Red + 0,5) | B8, B4 | 10 m |

- Denominadores com valor absoluto menor que 10⁻⁶ são mascarados; valores negativos legítimos são preservados.
- Nenhuma máscara de nuvens é aplicada automaticamente. A porcentagem de nuvens exibida refere-se à cena inteira.

### Classes de NDVI

| Classe | Intervalo |
|---|---|
| 1 · Valores negativos | −1 ≤ NDVI < 0 |
| 2 · Muito baixa | 0 ≤ NDVI < 0,2 |
| 3 · Baixa | 0,2 ≤ NDVI < 0,4 |
| 4 · Moderada | 0,4 ≤ NDVI < 0,6 |
| 5 · Elevada | 0,6 ≤ NDVI ≤ 1 |

Valores fora de [−1, 1], que só ocorrem com refletância negativa, ficam fora das classes, da média e da série temporal.

### Estatísticas

- Calculadas na grade nativa de cada cena, com ponderação pela área de cada pixel e pela fração dele dentro do talhão.
- A área do talhão é geodésica e vetorial; a área válida considera somente pixels com valor.

### Clima

- ERA5-Land diário (reanálise, grade de cerca de 11 km).
- Média espacial ponderada pela área de interseção entre cada célula e o talhão, válida também para talhões menores que uma célula.
- Temperatura: média diária a 2 m (°C). Precipitação: total diário (mm).

### Suavização visual

A suavização usa interpolação de exibição (`ee.Image.resample`) apenas nas camadas RGB e de índice mostradas no mapa. Ela **não cria detalhes nem aumenta a resolução real**. Estatísticas, classes, séries e escalas de cor são sempre calculadas sobre os pixels nativos, e as classes de NDVI nunca são interpoladas.

## Desempenho e limites

| Parâmetro | Valor padrão |
|---|---|
| Pixels por redução | 30 000 000 |
| Consultas simultâneas | 3 (uma reservada à interface) |
| Cenas por lote da série | 8 |
| Dias por lote do clima | 30 |
| Repetições automáticas por lote | 2 |
| Feições listadas por coleção | 1 000 |

Os valores podem ser ajustados no objeto `C`, no início do script. As escalas espaciais nunca são reduzidas automaticamente para contornar limites.

## Limitações conhecidas

- Talhões na sobreposição de dois tiles Sentinel-2 podem ter duas cenas na mesma data.
- Coleções com mais de 1 000 feições mostram apenas as primeiras na lista; o clique no mapa alcança todas.
- O Earth Engine não valida geometrias autointersectadas; corrija-as antes de importar.
- O ERA5-Land é publicado com alguns dias de atraso.

## Fontes de dados

- [Sentinel-2 SR Harmonized](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED): contém dados Copernicus Sentinel modificados (União Europeia / ESA).
- [ERA5-Land Daily Aggregated](https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR): ECMWF / Copernicus Climate Change Service (C3S).

## Histórico de versões

Consulte o [CHANGELOG](CHANGELOG.md).
