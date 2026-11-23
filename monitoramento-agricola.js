/**
 * Monitoramento Agrícola · Google Earth Engine
 *
 * Aplicação interativa para análise de talhões com imagens Sentinel-2
 * (COPERNICUS/S2_SR_HARMONIZED) e clima ERA5-Land (ECMWF/ERA5_LAND/DAILY_AGGR).
 *
 * Uso: cole este arquivo no Code Editor (https://code.earthengine.google.com),
 * importe os talhões e execute. Consulte o README para configuração.
 *
 * Estrutura:
 *   1. Configuração (talhões importados, suavização, constantes)
 *   2. Estado e fila assíncrona
 *   3. Processamento espectral
 *   4. Componentes visuais
 *   5. Talhões: importação, adoção e desenho opcional
 *   6. Pesquisa, paginação e seleção de cenas
 *   7. Estatísticas por classe
 *   8. Séries temporais e clima
 *   9. Cabeçalho e inicialização
 */
(function () {
  'use strict';

  // 1. CONFIGURAÇÃO ----------------------------------------------------------
  // 1.1 TALHÕES IMPORTADOS. O Code Editor NÃO oferece API para listar o painel
  // Imports; por isso cada variável importada é registrada aqui. Para incluir
  // outro import, acrescente uma linha (o nome da variável aparece duas vezes):
  //   {nome: 'Fazenda X', obter: function () { return typeof fazendaX !== 'undefined' ? fazendaX : null; },
  //    campoNome: 'NOME'},
  // - obter: devolve ee.Geometry, ee.Feature ou ee.FeatureCollection (Polygon/MultiPolygon).
  // - campoNome (opcional): atributo com o nome de cada talhão de uma coleção;
  //   sem ele, usa-se nome/name/talhao/id/codigo… e, por fim, system:index.
  // Os nomes padrão do Code Editor já vêm registrados; os inexistentes são ignorados.
  var TALHOES_IMPORTADOS = [
    {nome: 'geometry', obter: function () { return typeof geometry !== 'undefined' ? geometry : null; }},
    {nome: 'geometry2', obter: function () { return typeof geometry2 !== 'undefined' ? geometry2 : null; }},
    {nome: 'geometry3', obter: function () { return typeof geometry3 !== 'undefined' ? geometry3 : null; }},
    {nome: 'table', obter: function () { return typeof table !== 'undefined' ? table : null; }},
    {nome: 'table2', obter: function () { return typeof table2 !== 'undefined' ? table2 : null; }},
    {nome: 'table3', obter: function () { return typeof table3 !== 'undefined' ? table3 : null; }}
  ];
  var NAME_FIELDS = ['nome', 'Nome', 'NOME', 'name', 'Name', 'NAME', 'talhao', 'Talhao', 'TALHAO',
    'talhão', 'Talhão', 'TALHÃO', 'id', 'ID', 'Id', 'codigo', 'CODIGO', 'cod', 'COD', 'label', 'fid', 'FID'];
  // 1.2 SUAVIZAÇÃO VISUAL: só interpolação de exibição (ee.Image.resample).
  var SMOOTHING = {
    off: {label: 'Desativada', method: null},
    light: {label: 'Suave', method: 'bilinear'},
    intense: {label: 'Intensificada', method: 'bicubic'}
  };
  // A escala de cores é sempre automática, a partir da cena e do talhão.
  // A camada espectral permanece oculta até receber limites reais válidos.
  var C = {
    sentinel: 'COPERNICUS/S2_SR_HARMONIZED',
    climate: 'ECMWF/ERA5_LAND/DAILY_AGGR',
    defaultDays: 90,
    defaultSmoothing: 'light',
    pageSize: 80,                 // Todas as páginas ficam acessíveis nos dois lados.
    spectralBatch: 8,             // Processamento incremental de TODAS as cenas.
    climateBatch: 30,             // Dias por consulta (amostra poucas células ~11 km).
    batchRetries: 2,              // Repetições automáticas de um lote com falha.
    retryDelayMs: 3000,
    simultaneousRequests: 3,      // Uma vaga fica sempre reservada à interface.
    maxImportFeatures: 1000,      // Feições listadas por coleção importada.
    maxSelectItems: 300,          // Itens exibidos de uma vez no seletor (use o filtro).
    maxPixels: 30000000,          // Erro explícito se excedido; escala não é alterada.
    tileScale: 4,
    maxClimateCells: 10000,       // Guarda explícita para AOIs continentais.
    epsilon: 1e-6,
    rawCacheSize: 24,
    visualizationCacheSize: 64,
    visualizationRetryMs: 30000,
    statBarPixels: 236,
    blue: '#2563eb', green: '#17734b', ink: '#253349', muted: '#64748b',
    line: '#dce3eb', background: '#f4f7fa', danger: '#b42335',
    rgb: {bands: ['B4', 'B3', 'B2'], min: 0, max: 0.3, gamma: 1.15},
    example: [-47.815, -15.625, -47.795, -15.605]
  };
  var vegetationPalette = [
    '8d2735', 'b84b4b', 'c7806b', 'd8a28c', 'e2bd83', 'ebce66',
    'c9dc85', '91c46b', '58a64f', '24763a', '0b492d'
  ];
  var INDEX = {
    NDVI: {name: 'NDVI · Vegetação', scale: 10,
      palette: vegetationPalette, meaning: 'Baixo ← vigor vegetativo → alto'},
    NDWI: {name: 'NDWI · Água (Green/NIR)', scale: 10,
      palette: ['8c510a', 'd8b365', 'f5f5f5', '80cdc1', '01665e', '084b83'],
      meaning: 'Menor ← resposta de água → maior'},
    NDMI: {name: 'NDMI · Umidade (NIR/SWIR)', scale: 20,
      palette: ['8c510a', 'dfc27d', 'f6e8c3', 'c7eae5', '5ab4ac', '01665e'],
      meaning: 'Menor ← umidade espectral → maior'},
    EVI: {name: 'EVI · Vegetação melhorado', scale: 10,
      palette: ['a54b4b', 'e6c875', 'd3df9c', '8bc36d', '3b914e', '0b492d'],
      meaning: 'Menor ← resposta vegetativa → maior'},
    SAVI: {name: 'SAVI · Ajuste ao solo (L=0,5)', scale: 10,
      palette: ['a54b4b', 'dba56d', 'ead583', 'b5d47a', '5da756', '0b492d'],
      meaning: 'Menor ← resposta vegetativa → maior'}
  };
  // K-means: 3 grupos com as bandas abaixo; classes ordenadas pelo NDVI médio.
  var KMEANS = {
    bands: ['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
    clusters: 3,
    samplesPerDate: 5000,
    classNames: ['1 · NDVI médio menor', '2 · NDVI médio intermediário', '3 · NDVI médio maior'],
    classColors: ['c9a66b', 'a6c96a', '1f7a3a'],
    changeNames: ['Perda (classe desceu)', 'Sem mudança', 'Ganho (classe subiu)'],
    changeColors: ['d7301f', 'bdbdbd', '1a9850']
  };
  var CLASS = [
    {text: '1 · Valores negativos  [−1; 0[', color: '#bc5960'},
    {text: '2 · Muito baixa  [0; 0,2[', color: '#d7b74b'},
    {text: '3 · Baixa  [0,2; 0,4[', color: '#acd570'},
    {text: '4 · Moderada  [0,4; 0,6[', color: '#4fa967'},
    {text: '5 · Elevada  [0,6; 1]', color: '#14633c'}
  ];

  // 2. ESTADO E FILA ASSÍNCRONA ---------------------------------------------
  var S = {
    aoi: null, aoiReady: false, areaM2: null, regionVersion: 0,
    searchVersion: 0, searchBusy: false, period: null, collection: null, count: 0,
    pageCache: {}, pagePending: {}, statsCache: {}, rawCache: {}, rawOrder: [],
    visualizationCache: {}, visualizationPending: {}, visualizationOrder: [],
    visualizationRegionVersion: 0,
    indexJobs: {}, climateJob: null, chartIndex: 'NDVI', chartsOpen: false,
    wipe: true, drawingMode: false, drawingRequestVersion: 0, drawingSessionVersion: 0,
    pendingDraw: null, drawingSessionLayers: [], suppressDrawing: false, tool: 'navigate',
    aoiRequest: 0, aoiBounds: null, aoiImport: null, smoothing: C.defaultSmoothing,
    imports: {sources: [], byKey: {}, rows: {}, currentRows: [], source: null, version: 0},
    kmeans: {active: false, version: 0, view: 'classes'},
    queue: [], running: 0, background: 0, sides: {}, ui: {}
  };
  // Mesmo as camadas vazias possuem as bandas esperadas pelos visualizadores.
  var EMPTY = ee.Image.constant([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    .rename(['B4', 'B3', 'B2', 'NDVI', 'NDWI', 'NDMI', 'EVI', 'SAVI', 'classe', 'kclasse', 'mudanca'])
    .updateMask(ee.Image(0));

  // priority = consulta acionada pela interface; sem priority = lote de série.
  function enqueue(makeObject, current, done, priority) {
    var job = {make: makeObject, current: current, done: done, priority: !!priority};
    if (priority) S.queue.unshift(job); else S.queue.push(job);
    pump();
  }
  function pump() {
    // Lotes de séries ocupam no máximo simultaneousRequests − 1 vagas: seleção
    // de talhão, cena, escala e estatísticas nunca esperam uma série longa.
    var i = 0;
    while (S.running < C.simultaneousRequests && i < S.queue.length) {
      var job = S.queue[i];
      if (!job.current()) { S.queue.splice(i, 1); continue; }
      if (!job.priority && S.background >= C.simultaneousRequests - 1) { i++; continue; }
      S.queue.splice(i, 1);
      launch(job);
    }
    updateBusy();
  }
  function updateBusy() {
    if (!S.ui.busy) return;
    var waiting = S.queue.filter(function (job) { return job.current(); }).length;
    var total = S.running + waiting;
    S.ui.busy.setValue(total ? '⏳ ' + total + (total > 1 ? ' consultas' : ' consulta') : '✓ pronto');
  }
  function launch(job) {
    S.running++;
    if (!job.priority) S.background++;
    var finished = false;
    function finish(value, error) {
      if (finished) return;
      finished = true;
      S.running--;
      if (!job.priority) S.background--;
      try {
        if (job.current()) job.done(value, error);
      } catch (err) {
        setStatus('Erro de interface: ' + errorText(err), true);
        print('Detalhes do erro de interface', err);
      }
      pump();
    }
    try { job.make().evaluate(finish); } catch (err) { finish(null, err); }
  }
  function errorText(error) {
    return String(error && error.message ? error.message : error || 'erro desconhecido');
  }
  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function number(value, digits) {
    return finite(value) ? value.toFixed(digits).replace('.', ',') : '—';
  }
  function utc(time, withTime) {
    if (!finite(time)) return 'Data indisponível';
    var value = new Date(time).toISOString();
    return value.slice(8, 10) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4) +
      (withTime ? ' ' + value.slice(11, 19) + ' UTC' : '');
  }
  function chartDate(time) {
    // Google Charts formata Date no fuso do navegador. Estes componentes mantêm
    // o eixo em UTC, inclusive o dia ERA5 à meia-noite, sem retroceder uma data.
    var d = new Date(time);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }
  function eachSide(fn) { fn(S.sides.left); fn(S.sides.right); }
  function setStatus(text, error) {
    if (!S.ui.status) return;
    S.ui.status.setValue(text);
    S.ui.status.style().set('color', error ? C.danger : C.muted);
  }

  // 3. PROCESSAMENTO ESPECTRAL ---------------------------------------------
  function safeRatio(numerator, denominator, name) {
    numerator = ee.Image(numerator);
    denominator = ee.Image(denominator);
    var valid = denominator.abs().gte(C.epsilon);
    var safe = denominator.where(valid.not(), 1);
    return ee.Image(numerator.divide(safe).updateMask(valid).rename(name));
  }
  function calculateSpectralIndex(source, key) {
    var image = ee.Image(source);
    var ref = image.select(['B2', 'B3', 'B4', 'B8', 'B11']).multiply(0.0001);
    var nir = ref.select('B8');
    var red = ref.select('B4');
    var index;
    if (key === 'NDVI') {
      index = safeRatio(nir.subtract(red), nir.add(red), key);
    } else if (key === 'NDWI') {
      var green = ref.select('B3');
      index = safeRatio(green.subtract(nir), green.add(nir), key);
    } else if (key === 'NDMI') {
      var swir = ref.select('B11');
      var nir20 = nir.reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 64})
        .reproject({crs: swir.projection()});
      index = safeRatio(nir20.subtract(swir), nir20.add(swir), key);
    } else if (key === 'EVI') {
      var denominator = nir.add(red.multiply(6)).subtract(ref.select('B2').multiply(7.5)).add(1);
      index = safeRatio(nir.subtract(red).multiply(2.5), denominator, key);
    } else if (key === 'SAVI') {
      index = safeRatio(nir.subtract(red).multiply(1.5), nir.add(red).add(0.5), key);
    } else {
      throw new Error('Índice desconhecido: ' + key);
    }
    // Não usar normalizedDifference: pode mascarar entradas negativas por padrão.
    return ee.Image(index.copyProperties(image, ['system:time_start', 'system:index']));
  }
  function classifyNDVI(ndvi) {
    ndvi = ee.Image(ndvi).select('NDVI');
    // Limites inferiores inclusivos; superiores exclusivos, exceto 1 na classe 5.
    return ee.Image(ndvi.multiply(0).add(1)
      .where(ndvi.gte(0), 2).where(ndvi.gte(0.2), 3)
      .where(ndvi.gte(0.4), 4).where(ndvi.gte(0.6), 5)
      .updateMask(ndvi.gte(-1).and(ndvi.lte(1))).rename('classe').toByte());
  }
  function zeroIfNull(dictionary, key) {
    var value = ee.Dictionary(dictionary).get(key, 0);
    return ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(value, null), 0, value));
  }
  function analyticalIndex(source, key) {
    var index = calculateSpectralIndex(source, key);
    // NDVI fora de [−1; 1] só surge com refletância negativa. É excluído como
    // nas classes, para média, cobertura, classes e série usarem o mesmo conjunto.
    return key === 'NDVI' ? ee.Image(index.updateMask(index.gte(-1).and(index.lte(1)))) : index;
  }
  function reduceOnGrid(stack, projection, region) {
    // A Projection já contém CRS e transformação afim (grade nativa da banda).
    // Projection.transform() devolve texto WKT, não a lista de 6 números que
    // crsTransform exige; por isso a grade é informada somente por crs.
    return ee.Image(stack).reduceRegion({
      reducer: ee.Reducer.sum(), geometry: region, crs: projection,
      maxPixels: C.maxPixels, tileScale: C.tileScale
    });
  }
  function summarizeIndex(source, key, region) {
    var image = ee.Image(source);
    var index = analyticalIndex(image, key);
    var area = ee.Image.pixelArea();
    var sums = reduceOnGrid(area.rename('total')
      .addBands(area.updateMask(index.mask()).rename('valid'))
      .addBands(index.multiply(area).rename('weighted')), index.projection(), region);
    var valid = zeroIfNull(sums, 'valid');
    return ee.Dictionary({
      index: image.get('system:index'), time: image.get('system:time_start'),
      cloud: image.get('CLOUDY_PIXEL_PERCENTAGE'),
      validArea: valid, totalArea: zeroIfNull(sums, 'total'),
      mean: ee.Algorithms.If(valid.gt(0),
        zeroIfNull(sums, 'weighted').divide(valid.max(1e-12)), null)
    });
  }
  function calculateClassAreas(source, region) {
    var ndvi = calculateSpectralIndex(source, 'NDVI');
    var classes = classifyNDVI(ndvi);
    var area = ee.Image.pixelArea();
    var validNDVI = ndvi.updateMask(classes.mask());
    var stack = area.rename('total')
      .addBands(area.updateMask(classes.mask()).rename('valid'))
      .addBands(validNDVI.multiply(area).rename('weighted'));
    CLASS.forEach(function (_, i) {
      stack = stack.addBands(area.updateMask(classes.eq(i + 1)).rename('c' + (i + 1)));
    });
    var sums = reduceOnGrid(stack, ndvi.projection(), region);
    var valid = zeroIfNull(sums, 'valid');
    var total = zeroIfNull(sums, 'total');
    var classAreas = ee.List.sequence(1, 5).map(function (i) {
      return zeroIfNull(sums, ee.String('c').cat(ee.Number(i).format('%d')));
    });
    return ee.Dictionary({
      mean: ee.Algorithms.If(valid.gt(0),
        zeroIfNull(sums, 'weighted').divide(valid.max(1e-12)), null),
      validArea: valid, totalArea: total, classAreas: classAreas,
      coverage: ee.Algorithms.If(total.gt(0), valid.divide(total.max(1e-12)).multiply(100), null),
      percentages: classAreas.map(function (value) {
        return ee.Algorithms.If(valid.gt(0), ee.Number(value).divide(valid.max(1e-12)).multiply(100), null);
      })
    });
  }
  function sceneProducts(id) {
    if (S.rawCache[id]) return S.rawCache[id];
    var raw = ee.Image(id);
    var item = {raw: raw, rgb: raw.select(['B4', 'B3', 'B2']).multiply(0.0001), indices: {}};
    S.rawCache[id] = item;
    S.rawOrder.push(id);
    if (S.rawOrder.length > C.rawCacheSize) delete S.rawCache[S.rawOrder.shift()];
    return item;
  }
  function sceneIndex(id, key) {
    var product = sceneProducts(id);
    if (!product.indices[key]) product.indices[key] = analyticalIndex(product.raw, key);
    return ee.Image(product.indices[key]);
  }
  // Camada de APRESENTAÇÃO: a própria imagem analítica com interpolação de
  // exibição (resample usa a grade nativa da imagem: 10 m; NDMI 20 m). Não
  // cria detalhe, não altera pixels nativos e nunca entra em reduceRegion,
  // classes, séries ou escalas. As classes NDVI (categóricas) não a usam.
  function visualImage(image) {
    var method = SMOOTHING[S.smoothing].method;
    return method ? ee.Image(image).resample(method) : ee.Image(image);
  }

  // 4. COMPONENTES VISUAIS --------------------------------------------------
  function label(text, style) {
    var base = {fontSize: '11px', color: C.ink, margin: '1px 0'};
    Object.keys(style || {}).forEach(function (key) { base[key] = style[key]; });
    return ui.Label(text, base);
  }
  function row(widgets, style) {
    return ui.Panel({widgets: widgets, layout: ui.Panel.Layout.flow('horizontal'),
      style: style || {stretch: 'horizontal', margin: '0', padding: '0'}});
  }
  function button(text, fn, primary, style) {
    var base = {fontSize: '10px', margin: '1px', padding: '3px 5px',
      color: primary ? '#ffffff' : C.ink,
      backgroundColor: primary ? C.blue : '#f1f5f9', border: '0px'};
    Object.keys(style || {}).forEach(function (key) { base[key] = style[key]; });
    return ui.Button({label: text, onClick: fn, style: base});
  }
  function card(widgets, extra) {
    var style = {width: '260px', padding: '7px', margin: '0',
      backgroundColor: '#ffffff', border: '1px solid ' + C.line,
      borderRadius: '7px'};
    Object.keys(extra || {}).forEach(function (key) { style[key] = extra[key]; });
    return ui.Panel({widgets: widgets || [], style: style});
  }
  function indexItems() {
    return Object.keys(INDEX).map(function (key) { return {label: INDEX[key].name, value: key}; });
  }
  function createDrawingMap() {
    // IMPORTANTE: drawingTools() também insere controles nativos no mapa.
    // Criá-los antes de overlays, Linker ou SplitPanel evita a montagem tardia
    // que provoca o erro Node.insertBefore.
    var editor = ui.Map();
    var drawing = editor.drawingTools();
    drawing.setLinked(false);
    drawing.setDrawModes(['polygon', 'rectangle']);
    drawing.setShown(false);
    drawing.layers().reset([]);
    S.ui.editorMap = editor;
    S.ui.drawing = drawing;
    editor.setOptions('HYBRID');
    editor.setControlVisibility({all: false, zoomControl: true, scaleControl: true});
    editor.style().set({position: 'top-left', width: '100%', height: '100%',
      shown: false, margin: '0', cursor: 'crosshair'});
    S.ui.editorRGB = ui.Map.Layer(EMPTY, C.rgb, 'RGB de referência · lado esquerdo', false);
    editor.layers().add(S.ui.editorRGB);
  }
  function createComparisonMaps() {
    ['left', 'right'].forEach(function (key) {
      var map = ui.Map();
      map.setOptions('HYBRID');
      map.setControlVisibility({all: false, zoomControl: true, scaleControl: true});
      map.style().set({stretch: 'both', cursor: 'hand'});
      var side = {key: key, name: key === 'left' ? 'Lado Esquerdo' : 'Lado Direito',
        map: map, id: null, metadata: null, index: 'NDVI', selectionVersion: 0,
        visualizationVersion: 0, visualizationRange: null,
        pageVersion: 0, page: 0, pageRows: [], showRGB: false, showIndex: true,
        showClasses: false, showOutline: true, ui: {}};
      side.layers = {
        rgb: ui.Map.Layer(EMPTY, C.rgb, 'RGB · sem cena', false),
        index: ui.Map.Layer(EMPTY, {}, 'Índice · sem cena', false),
        classes: ui.Map.Layer(EMPTY, {bands: ['classe'], min: 1, max: 5,
          palette: CLASS.map(function (x) { return x.color; })}, 'Classes NDVI', false),
        kmeans: ui.Map.Layer(EMPTY, {bands: ['kclasse'], min: 1, max: 3,
          palette: KMEANS.classColors}, 'K-means · 3 classes', false),
        change: ui.Map.Layer(EMPTY, {bands: ['mudanca'], min: 1, max: 3,
          palette: KMEANS.changeColors}, 'K-means · diferença entre datas', false),
        sources: ui.Map.Layer(EMPTY, {}, 'Talhões do import', false),
        outline: ui.Map.Layer(EMPTY, {}, 'Limite do talhão', false)
      };
      map.layers().add(side.layers.rgb);
      map.layers().add(side.layers.index);
      map.layers().add(side.layers.classes);
      map.layers().add(side.layers.kmeans);
      map.layers().add(side.layers.change);
      map.layers().add(side.layers.sources);
      map.layers().add(side.layers.outline);
      // Com o painel de talhões aberto, um clique no mapa escolhe a feição.
      map.onClick(pickImportedAt);
      S.sides[key] = side;
    });
    S.ui.linker = ui.Map.Linker([S.sides.left.map, S.sides.right.map, S.ui.editorMap]);
    S.ui.split = ui.SplitPanel({firstPanel: S.sides.left.map,
      secondPanel: S.sides.right.map, orientation: 'horizontal', wipe: true,
      style: {position: 'top-left', width: '100%', height: '100%', shown: true, margin: '0'}});
    // Cada mapa conserva o mesmo pai durante toda a execução.
    S.ui.stage = ui.Panel({widgets: [S.ui.split, S.ui.editorMap],
      layout: ui.Panel.Layout.absolute(), style: {stretch: 'both', margin: '0', padding: '0'}});
    S.sides.left.map.setCenter(-47.8, -15.61, 12);
  }
  function visualization(key, range) {
    if (!range || range.key !== key ||
        (range.source !== 'auto' && range.source !== 'constant') ||
        !finite(range.min) || !finite(range.max) || range.min >= range.max) return null;
    return {bands: [key], min: range.min, max: range.max, palette: INDEX[key].palette};
  }
  function resolveVisualizationRange(key, result, error) {
    function read(suffix) { return result ? result[key + '_' + suffix] : null; }
    var min = read('min'), max = read('max'), low = read('p2'), high = read('p98');
    if (error || !finite(min) || !finite(max) || min > max) {
      var empty = !error && (min === null || min === undefined) &&
        (max === null || max === undefined);
      return {key: key, source: empty ? 'empty' : 'error',
        note: empty ? 'sem pixels válidos' : 'falha ao calcular a escala'};
    }
    var extremes = 'mín ' + number(min, 3) + ' · máx ' + number(max, 3);
    if (finite(low) && finite(high) && low < high) {
      // Percentis 2–98: poucos pixels extremos (nuvem, sombra, denominador
      // pequeno do EVI) não achatam a paleta. Só as cores mudam.
      return {key: key, min: low, max: high, source: 'auto',
        note: 'cores p2–p98 (extremos saturam) · ' + extremes};
    }
    if (min < max) return {key: key, min: min, max: max, source: 'auto', note: 'cores mín–máx · ' + extremes};
    if (min === max) {
      // Uma imagem constante precisa de min < max para a paleta. A folga é
      // aplicada só aos parâmetros visuais; nenhum pixel é modificado.
      var padding = Math.max(C.epsilon, Math.abs(min) * 1e-6);
      var lower = min - padding, upper = max + padding;
      if (!finite(lower) || !finite(upper) || lower >= upper) {
        return {key: key, source: 'error', note: 'faixa constante inválida'};
      }
      return {key: key, min: lower, max: upper, realMin: min, realMax: max,
        source: 'constant', note: 'constante; faixa visual ampliada'};
    }
    return {key: key, source: 'error', note: 'faixa inválida'};
  }
  function visualizationCacheKey(id, key) {
    return S.regionVersion + '|' + id + '|' + key;
  }
  function touchVisualizationCache(key) {
    var position = S.visualizationOrder.indexOf(key);
    if (position >= 0) S.visualizationOrder.splice(position, 1);
    S.visualizationOrder.push(key);
    while (S.visualizationOrder.length > C.visualizationCacheSize) {
      delete S.visualizationCache[S.visualizationOrder.shift()];
    }
  }
  function fetchVisualizationRange(id, key, index, done) {
    var cacheKey = visualizationCacheKey(id, key);
    var cached = S.visualizationCache[cacheKey];
    if (cached) {
      var success = cached.range.source === 'auto' || cached.range.source === 'constant';
      if (success || Date.now() - cached.time < C.visualizationRetryMs) {
        touchVisualizationCache(cacheKey); done(cached.range); return;
      }
    }
    var pending = S.visualizationPending[cacheKey];
    if (pending) { pending.listeners.push(done); return; }
    var version = S.regionVersion, region = S.aoi;
    pending = {listeners: [done]};
    S.visualizationPending[cacheKey] = pending;
    // Grade nativa do índice analítico (10 m; NDMI na B11 de 20 m), nunca a
    // camada suavizada. Sem bestEffort e sem máscaras novas.
    enqueue(function () {
      return ee.Image(index).reduceRegion({reducer: ee.Reducer.minMax().combine({
        reducer2: ee.Reducer.percentile([2, 98]), sharedInputs: true}), geometry: region,
        crs: index.projection(), maxPixels: C.maxPixels, tileScale: C.tileScale});
    }, function () {
      return version === S.regionVersion && S.visualizationPending[cacheKey] === pending;
    }, function (result, error) {
      var range = resolveVisualizationRange(key, result, error);
      delete S.visualizationPending[cacheKey];
      S.visualizationCache[cacheKey] = {range: range, time: Date.now()};
      touchVisualizationCache(cacheKey);
      var listeners = pending.listeners;
      pending.listeners = [];
      listeners.forEach(function (listener) {
        try { listener(range); } catch (err) {
          // Uma falha de widget em um lado não impede atualizar o outro.
          setStatus('Erro ao aplicar a escala visual: ' + errorText(err), true);
          print('Detalhes do erro de escala visual', err);
        }
      });
    }, true);
  }
  function formatVisualizationBound(value, other) {
    var precision = 6;
    while (precision < 17 && value.toPrecision(precision) === other.toPrecision(precision)) precision++;
    return String(Number(value.toPrecision(precision))).replace('.', ',');
  }
  function createImageSelectors(side) {
    var u = side.ui;
    u.scene = ui.Select({items: [], placeholder: 'Defina um talhão e pesquise',
      disabled: true, onChange: function (id) {
        if (!id) return;
        var metadata = null;
        side.pageRows.forEach(function (item) { if (sceneId(item) === id) metadata = item; });
        if (!metadata && side.id === id) metadata = side.metadata;
        if (metadata) selectScene(side, metadata);
      }, style: {stretch: 'horizontal', height: '26px', fontSize: '10px', margin: '1px 0'}});
    u.previous = button('‹', function () { loadSidePage(side, side.page - 1); }, false, {padding: '0 5px'});
    u.next = button('›', function () { loadSidePage(side, side.page + 1); }, false, {padding: '0 5px'});
    u.page = label('Sem cenas', {stretch: 'horizontal', fontSize: '9px', textAlign: 'center', margin: '2px 0'});
    u.previous.setDisabled(true); u.next.setDisabled(true);
    u.acquisition = label('Aquisição: —', {color: C.muted, fontSize: '10px'});
    u.satellite = label('Satélite / tile: —', {color: C.muted, fontSize: '9px'});
    u.index = ui.Select({items: indexItems(), value: 'NDVI',
      style: {stretch: 'horizontal', height: '26px', fontSize: '10px', margin: '1px 0'},
      onChange: function (key) {
        side.index = key;
        if (side.id) renderIndex(side);
        updateView(side);
        chooseChartIndex(key);
      }});
    u.indexButton = button('Visualizar índice', function () { setView(side, 'index'); }, true,
      {stretch: 'horizontal'});
    u.rgbButton = button('Visualizar RGB', function () { setView(side, 'rgb'); }, false,
      {stretch: 'horizontal'});
    u.indexButton.setDisabled(true); u.rgbButton.setDisabled(true);
    u.current = label('Nenhuma cena selecionada', {fontSize: '9px', color: C.muted});
    u.badge = label(side.name + ' · sem imagem', {fontSize: '10px', fontWeight: 'bold',
      color: C.green, margin: '0 0 2px'});
    u.legend = ui.Panel({style: {margin: '4px 0 0', padding: '0'}});
    u.controlBody = ui.Panel({widgets: [u.scene, row([u.previous, u.page, u.next]),
      u.acquisition, u.satellite, label('Índice espectral', {color: C.muted, fontSize: '10px'}), u.index,
      row([u.indexButton, u.rgbButton]), u.current, u.legend], style: {shown: true, margin: '0', padding: '0'}});
    u.controlToggle = button('−', function () {
      var open = !u.controlBody.style().get('shown');
      u.controlBody.style().set('shown', open);
      u.controlToggle.setLabel(open ? '−' : '+');
    }, false, {margin: '0', padding: '1px 6px'});
    u.controls = card([row([label(side.name, {fontWeight: 'bold', stretch: 'horizontal'}), u.controlToggle]),
      u.badge, u.controlBody]);
  }
  function createVegetationPanels(side) {
    var u = side.ui;
    u.statDate = label('Imagem: —', {color: C.muted, fontSize: '10px'});
    u.mean = label('NDVI médio: —', {fontSize: '10px'});
    u.coverage = label('Área válida: —', {fontSize: '10px'});
    u.statStatus = label('Defina um talhão.', {color: C.muted, fontSize: '10px'});
    u.classRows = CLASS.map(function (item) {
      var percent = label('—', {fontSize: '10px', fontWeight: 'bold', width: '47px', textAlign: 'right'});
      var bar = ui.Panel({style: {backgroundColor: item.color, width: '0px', height: '4px', margin: '0'}});
      var track = ui.Panel({widgets: [bar], layout: ui.Panel.Layout.flow('horizontal'),
        style: {width: C.statBarPixels + 'px', height: '4px', margin: '0 0 3px', padding: '0', backgroundColor: '#edf1f5'}});
      var line = row([label(item.text, {fontSize: '10px', stretch: 'horizontal'}), percent]);
      return {percent: percent, bar: bar, widget: ui.Panel([line, track], null,
        {padding: '0', margin: '0'})};
    });
    u.statsBody = ui.Panel({style: {shown: true, margin: '0', padding: '0'}});
    u.statsBody.add(u.statDate).add(u.mean).add(u.coverage);
    u.classRows.forEach(function (item) { u.statsBody.add(item.widget); });
    u.statsBody.add(u.statStatus);
    u.statsBody.add(label('Vigor pelo NDVI; não mede massa física.\nNuvens podem afetar todos os resultados.',
      {fontSize: '9px', color: C.muted, whiteSpace: 'pre-wrap'}));
    u.statsBody.add(button('Série Temporal e Clima', function () {
      chooseChartIndex(side.index); setChartsOpen(true);
    }, true, {stretch: 'horizontal'}));
    u.statsToggle = button('−', function () {
      var open = !u.statsBody.style().get('shown');
      u.statsBody.style().set('shown', open); u.statsToggle.setLabel(open ? '−' : '+');
    }, false, {padding: '0 5px', margin: '0'});
    var retry = button('↻', function () {
      if (side.id && S.aoiReady) {
        delete S.statsCache[statsKey(side.id)]; updateVegetationPanel(side);
      }
    }, false, {padding: '0 5px', margin: '0 4px'});
    u.stats = card([row([label('Distribuição do NDVI', {fontWeight: 'bold', stretch: 'horizontal'}),
      retry, u.statsToggle]), u.statsBody],
      {position: side.key === 'left' ? 'bottom-left' : 'bottom-right', margin: '8px'});
    side.map.add(u.stats);
  }
  function createToolbar() {
    var u = S.ui;
    u.toolButtons = {};
    function tool(key, text, fn, tip) {
      var paths = {
        navigate: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
        geometry: 'M4 6l12-3 5 12-13 6-4-15zM3 5h2v2H3zM15 2h2v2h-2zM20 14h2v2h-2zM7 20h2v2H7z',
        charts: 'M4 3v17h17M7 15l4-5 4 3 5-7',
        layers: 'M3 8l9-5 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
        compare: 'M3 4h18v16H3zM12 2v20M8 10l-2 2 2 2M16 10l2 2-2 2'
      };
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">' +
        '<path d="' + paths[key] + '" fill="none" stroke="#334155" stroke-width="1.7" ' +
        'stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // imageUrl é suportado nativamente; label vira a dica de mouse do ícone.
      var widget = ui.Button({label: tip, onClick: fn,
        imageUrl: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
        style: {width: '34px', height: '34px', padding: '4px', margin: '2px', border: '0px'}});
      u.toolButtons[key] = widget; return widget;
    }
    u.toolbar = ui.Panel({widgets: [
      tool('navigate', '↔', function () {
        finishDrawing(); closeTalhaoPanel();
      }, 'Concluir desenho e navegar'),
      tool('geometry', '▱', function () {
        if (u.geometryDrawer.style().get('shown')) closeTalhaoPanel(); else openImportPanel(false);
      }, 'Selecionar talhão importado (desenho manual opcional)'),
      tool('charts', '▥', function () { setChartsOpen(!S.chartsOpen); }, 'Abrir ou recolher gráficos'),
      tool('layers', '▤', function () {
        u.layerDrawer.style().set('shown', !u.layerDrawer.style().get('shown'));
        setTool('layers');
      }, 'Visibilidade das camadas'),
      tool('compare', '◧', function () {
        finishDrawing(); S.wipe = !S.wipe; u.split.setWipe(S.wipe); updateToolStyles();
        setStatus(S.wipe ? 'Cortina ativa: arraste o divisor central.' : 'Quadros sincronizados. Ative ◧ para voltar à cortina.');
      }, 'Alternar cortina deslizante / quadros sincronizados')
    ], style: {width: '40px', padding: '2px', margin: '0 7px 0 0', backgroundColor: '#ffffff',
      border: '1px solid ' + C.line, borderRadius: '7px'}});
    var selectStyle = {stretch: 'horizontal', height: '26px', fontSize: '10px', margin: '1px 0'};
    u.importSource = ui.Select({items: [], placeholder: 'Nenhum import registrado', disabled: true,
      onChange: function (key) { chooseImportSource(key, true); }, style: selectStyle});
    u.importFilter = ui.Textbox({placeholder: 'Filtrar por nome (Enter)…', onChange: populateFeatureSelect,
      style: {stretch: 'horizontal', fontSize: '10px', margin: '1px 0'}});
    u.importFeature = ui.Select({items: [], placeholder: 'Escolha o talhão', disabled: true,
      onChange: chooseImportedFeature, style: selectStyle});
    u.importStatus = label('', {fontSize: '10px', color: C.muted, whiteSpace: 'pre-wrap'});
    u.manualBody = ui.Panel({widgets: [
      row([button('Polígono', function () { startDrawing('polygon'); }, true),
        button('Retângulo', function () { startDrawing('rectangle'); }, true),
        button('Editar vértices', editDrawing)]),
      button('Área de exemplo', useExample, false, {stretch: 'horizontal'}),
      label('Para áreas ainda não importadas. O mapa fica em largura total;\n' +
        'o exemplo é só uma área geográfica, com dados reais.',
        {fontSize: '9px', color: C.muted, whiteSpace: 'pre-wrap'})
    ], style: {shown: false, margin: '0', padding: '0'}});
    u.manualToggle = button('▸ Desenho manual (opcional)', function () {
      var open = !u.manualBody.style().get('shown');
      u.manualBody.style().set('shown', open);
      u.manualToggle.setLabel((open ? '▾' : '▸') + ' Desenho manual (opcional)');
    }, false, {stretch: 'horizontal'});
    u.geometryDrawer = card([
      label('Talhões importados', {fontWeight: 'bold'}),
      label('Fonte (variável registrada em TALHOES_IMPORTADOS)', {fontSize: '9px', color: C.muted}),
      u.importSource, u.importFilter, u.importFeature, u.importStatus,
      label('Com este painel aberto, clique em um talhão no mapa para selecioná-lo.',
        {fontSize: '9px', color: C.muted}),
      row([button('Centralizar', centerAOI), button('Remover', removeAOI), button('Fechar', closeTalhaoPanel)]),
      u.manualToggle, u.manualBody
    ], {shown: false, margin: '5px 0 0'});
    u.layerDrawer = card([label('Camadas independentes', {fontWeight: 'bold'})],
      {shown: false, margin: '5px 0 0'});
    eachSide(function (side) {
      u.layerDrawer.add(label(side.name, {fontWeight: 'bold', margin: '6px 0 2px'}));
      side.ui.checks = {};
      [
        ['rgb', 'RGB', 'showRGB'], ['index', 'Índice selecionado', 'showIndex'],
        ['classes', 'Cinco classes de NDVI', 'showClasses'], ['outline', 'Limite do talhão', 'showOutline']
      ].forEach(function (spec) {
        var check = ui.Checkbox({label: spec[1], value: side[spec[2]],
          onChange: function (value) { side[spec[2]] = value; updateView(side); },
          style: {fontSize: '10px', margin: '2px 0'}});
        side.ui.checks[spec[0]] = check; u.layerDrawer.add(check);
      });
    });
    // Um único controle no mapa impede o empilhamento dos dois elementos.
    // As colunas verticais intermediárias mantêm a barra e a pilha branca
    // em suas alturas naturais, sem herdar a altura do vizinho na linha.
    createKMeansPanel();
    u.leftStack = ui.Panel({
      widgets: [S.sides.left.ui.controls, u.geometryDrawer, u.layerDrawer, u.kmeansCard],
      layout: ui.Panel.Layout.flow('vertical'),
      style: {width: '260px', height: 'auto', padding: '0', margin: '0'}
    });
    var leftColumns = [u.toolbar, u.leftStack].map(function (widget) {
      return ui.Panel({widgets: [widget], layout: ui.Panel.Layout.flow('vertical'),
        style: {padding: '0', margin: '0', backgroundColor: '#ffffff00'}});
    });
    u.leftAnchor = ui.Panel({widgets: leftColumns,
      layout: ui.Panel.Layout.flow('horizontal'),
      style: {position: 'top-left', padding: '0', margin: '8px', backgroundColor: '#ffffff00'}});
    S.sides.left.map.add(u.leftAnchor);
    S.sides.right.ui.controls.style().set({position: 'top-right', margin: '8px'});
    S.sides.right.map.add(S.sides.right.ui.controls);
    updateToolStyles();
  }
  function setTool(key) { S.tool = key; updateToolStyles(); }
  function updateToolStyles() {
    if (!S.ui.toolButtons) return;
    Object.keys(S.ui.toolButtons).forEach(function (key) {
      var active = key === 'compare' ? S.wipe : key === 'charts' ? S.chartsOpen : S.tool === key;
      S.ui.toolButtons[key].style().set({backgroundColor: active ? '#e7efff' : '#ffffff',
        color: active ? C.blue : C.ink});
    });
  }

  // 5. TALHÃO, IMPORTAÇÃO E EDIÇÃO -----------------------------------------
  function configureDrawingTools() {
    // Usa a referência criada no mapa vazio, sem chamar drawingTools() novamente.
    var drawing = S.ui.drawing;
    var drawn = ui.util.debounce(function () {
      if (commitPendingDraw()) finishDrawing();
    }, 80);
    var edited = ui.util.debounce(function () {
      if (!S.drawingMode || !S.drawingDirty) return;
      S.drawingDirty = false; readDrawing();
    }, 650);
    function isCurrentLayer(layer) {
      if (!layer) return false;
      var found = false;
      drawing.layers().forEach(function (candidate) { if (candidate === layer) found = true; });
      return found;
    }
    drawing.onDraw(function (newGeometry, layer) {
      if (S.suppressDrawing || !S.drawingMode) return;
      if (!isCurrentLayer(layer)) return;
      rememberDrawingLayers();
      // Não substitui layers() dentro do evento nativo que acabou de inserir
      // a geometria. A confirmação ocorre depois que o evento termina.
      S.pendingDraw = {geometry: ee.Geometry(newGeometry), session: S.drawingSessionVersion};
      drawn();
    });
    function geometryChanged(geometry, layer, erased) {
      if (S.suppressDrawing || !S.drawingMode) return;
      if (layer && !isCurrentLayer(layer) &&
          !(erased && S.drawingSessionLayers.indexOf(layer) >= 0)) return;
      // Uma edição/remoção mais recente invalida o snapshot do onDraw.
      S.pendingDraw = null;
      // Invalida imediatamente os callbacks anteriores; espera a pausa da edição.
      S.drawingDirty = true;
      S.regionVersion++; S.aoiReady = false; S.aoiRequest++;
      S.ui.area.setValue('Talhão em edição…');
      invalidateData('Limites em edição…');
      edited();
    }
    drawing.onEdit(function (geometry, layer) { geometryChanged(geometry, layer, false); });
    drawing.onErase(function (geometry, layer) { geometryChanged(geometry, layer, true); });
    var editorPanel = card([
      label('Desenhar / editar talhão', {fontWeight: 'bold'}),
      label('O comparador permanece preservado.\nConclua o polígono com duplo clique.',
        {fontSize: '10px', color: C.muted, whiteSpace: 'pre-wrap'}),
      row([button('Polígono', function () { startDrawing('polygon'); }, true),
        button('Retângulo', function () { startDrawing('rectangle'); }, true)]),
      row([button('Centralizar', centerAOI), button('Remover', removeAOI)]),
      button('Concluir / voltar à comparação', finishDrawing, true, {stretch: 'horizontal'}),
      label('RGB da cena esquerda, quando selecionada; fundo HYBRID para navegação.',
        {fontSize: '9px', color: C.muted})
    ], {position: 'top-right', margin: '8px'});
    S.ui.editorMap.add(editorPanel);
  }
  function commitPendingDraw() {
    var pending = S.pendingDraw;
    S.pendingDraw = null;
    if (!pending || !S.drawingMode || pending.session !== S.drawingSessionVersion) return false;
    S.drawingDirty = false;
    adoptAOI(pending.geometry, 'Talhão desenhado', true);
    return true;
  }
  function setDrawingGeometry(geo) {
    S.suppressDrawing = true;
    S.ui.drawing.stop();
    S.ui.drawing.setSelected(null);
    S.drawingSessionLayers = [];
    S.ui.drawing.layers().reset(geo ? [ui.Map.GeometryLayer({
      geometries: [geo], name: 'Talhão em análise', color: '#ffffff', shown: S.drawingMode, locked: false
    })] : []);
    S.suppressDrawing = false;
  }
  function rememberDrawingLayers() {
    S.ui.drawing.layers().forEach(function (layer) {
      if (S.drawingSessionLayers.indexOf(layer) < 0) S.drawingSessionLayers.push(layer);
    });
  }
  function readDrawing() {
    var features = [];
    var layers = S.ui.drawing.layers();
    for (var i = 0; i < layers.length(); i++) {
      var layer = layers.get(i);
      if (layer.geometries().length()) features.push(ee.Feature(layer.toGeometry()));
    }
    if (!features.length) { removeAOI(); return; }
    var geo = ee.FeatureCollection(features).geometry(1).dissolve(1);
    adoptAOI(geo, 'Talhão editado', true);
  }
  function enterDrawingMode() {
    rememberDrawingLayers();
    if (S.drawingMode) return;
    S.drawingSessionVersion++;
    S.drawingMode = true;
    S.ui.split.style().set('shown', false);
    S.ui.editorMap.style().set('shown', true);
    S.ui.drawing.setShown(true);
    S.ui.drawing.layers().forEach(function (layer) { layer.setShown(true); });
    setTool('geometry');
  }
  function finishDrawing() {
    S.drawingRequestVersion++;
    if (!S.ui.drawing) return;
    var wasDrawing = S.drawingMode;
    var committed = commitPendingDraw();
    S.suppressDrawing = true;
    S.ui.drawing.stop();
    S.suppressDrawing = false;
    if (!committed && S.drawingDirty) { S.drawingDirty = false; readDrawing(); }
    S.ui.drawing.setShown(false);
    S.ui.drawing.layers().forEach(function (layer) { layer.setShown(false); });
    S.pendingDraw = null;
    S.drawingSessionLayers = [];
    S.drawingSessionVersion++;
    S.drawingMode = false;
    S.ui.editorMap.style().set('shown', false);
    S.ui.split.style().set('shown', true);
    // Só fecha o painel ao sair do modo de desenho; abrir a lista de imports
    // também chama esta função e precisa manter o painel visível.
    if (wasDrawing) closeTalhaoPanel();
  }
  function startDrawing(shape) {
    S.drawingRequestVersion++;
    S.pendingDraw = null; S.drawingDirty = false;
    S.drawingSessionVersion++;
    // Esta substituição acontece no clique do botão, fora dos callbacks nativos
    // de inserção/remoção de geometria.
    setDrawingGeometry(null);
    var layer = ui.Map.GeometryLayer({geometries: [], name: 'Novo talhão', color: '#ffffff'});
    S.ui.drawing.layers().add(layer);
    enterDrawingMode();
    S.ui.drawing.stop();
    S.ui.drawing.setSelected(layer);
    S.ui.drawing.setShape(shape);
    S.ui.drawing.draw();
    setStatus('Desenhe o ' + (shape === 'polygon' ? 'polígono' : 'retângulo') +
      '. O desenho completo substituirá o talhão anterior.');
  }
  function editDrawing() {
    if (!S.aoiReady) { setStatus('Defina primeiro um talhão válido.', true); return; }
    var version = S.regionVersion, geo = S.aoi, request = ++S.drawingRequestVersion;
    setStatus('Preparando os vértices para edição…');
    // Geometrias computadas (por exemplo, um FeatureCollection importado) precisam
    // de coordenadas no cliente para a ferramenta nativa permitir editar vértices.
    enqueue(function () { return geo; }, function () {
      return version === S.regionVersion && request === S.drawingRequestVersion;
    },
      function (json, error) {
        if (error || !json) { setStatus('Falha ao abrir os vértices: ' + errorText(error), true); return; }
        setDrawingGeometry(ee.Geometry(json));
        S.drawingDirty = false; S.pendingDraw = null;
        enterDrawingMode();
        S.ui.drawing.setSelected(S.ui.drawing.layers().get(0));
        S.ui.drawing.edit();
        setStatus('Edite os vértices. Clique em Concluir / navegar para voltar à cortina.');
      }, true);
  }
  // 5.1 TALHÕES IMPORTADOS ------------------------------------------------
  function setImportStatus(text, error) {
    S.ui.importStatus.setValue(text);
    S.ui.importStatus.style().set('color', error ? C.danger : C.muted);
  }
  function resolveImports() {
    // Apenas o registro explícito: não existe API para enumerar imports.
    var sources = [], byKey = {}, problems = [];
    TALHOES_IMPORTADOS.forEach(function (entry, i) {
      var value = null;
      try { value = entry.obter(); } catch (err) {
        // ReferenceError = import inexistente (entrada sem guarda typeof).
        if (!(err instanceof ReferenceError)) problems.push(entry.nome + ': ' + errorText(err));
        return;
      }
      if (value === null || value === undefined) return;
      var kind = value instanceof ee.FeatureCollection ? 'FeatureCollection' :
        value instanceof ee.Feature ? 'Feature' : value instanceof ee.Geometry ? 'Geometry' : null;
      if (!kind) { problems.push(entry.nome + ': não é Geometry, Feature nem FeatureCollection'); return; }
      var source = {key: 's' + i, name: entry.nome, kind: kind, value: value, nameField: entry.campoNome || null};
      sources.push(source); byKey[source.key] = source;
    });
    return {sources: sources, byKey: byKey, problems: problems};
  }
  function openImportPanel(auto) {
    finishDrawing();
    S.ui.geometryDrawer.style().set('shown', true);
    setTool('geometry');
    refreshImportSources(auto);
  }
  function closeTalhaoPanel() {
    S.ui.geometryDrawer.style().set('shown', false);
    setTool('navigate');
    updateSourceLayer();
  }
  function refreshImportSources(auto) {
    var im = S.imports, found = resolveImports(), u = S.ui;
    im.sources = found.sources; im.byKey = found.byKey;
    var problems = found.problems.length ? '\nIgnorados: ' + found.problems.join('; ') : '';
    u.importSource.setValue(null, false);
    u.importSource.items().reset(found.sources.map(function (source) {
      return {label: source.name + ' · ' + source.kind, value: source.key};
    }));
    u.importSource.setDisabled(!found.sources.length);
    if (!found.sources.length) {
      im.source = null; im.version++; im.currentRows = [];
      populateFeatureSelect();
      setImportStatus('Nenhum talhão importado encontrado. Importe uma geometria ou uma tabela (asset) ' +
        'no painel Imports e registre a variável em TALHOES_IMPORTADOS, no início do script.' + problems, true);
      updateSourceLayer();
      return;
    }
    var key = im.source && im.byKey[im.source.key] ? im.source.key : found.sources[0].key;
    u.importSource.setValue(key, false);
    // Reabrir o painel não reaplica o talhão atual; só a inicialização (auto)
    // ou uma troca de fonte pelo usuário seleciona automaticamente um talhão único.
    chooseImportSource(key, auto);
    if (problems) setImportStatus(u.importStatus.getValue() + problems, true);
  }
  function chooseImportSource(key, adoptSingle) {
    var im = S.imports, source = im.byKey[key];
    if (!source) return;
    im.source = source; im.version++;
    S.ui.importFilter.setValue('', false);
    updateSourceLayer();
    if (source.kind !== 'FeatureCollection') {
      setRows(source, [{k: null, i: 0, name: source.name, type: null, area: null}], 1);
      if (adoptSingle) adoptImportedRow(source, im.currentRows[0]);
      return;
    }
    var cached = im.rows[key];
    if (cached) {
      setRows(source, cached.rows, cached.size);
      if (adoptSingle && cached.rows.length === 1) adoptImportedRow(source, cached.rows[0]);
      return;
    }
    var version = im.version, fc = ee.FeatureCollection(source.value);
    var fields = source.nameField ? [source.nameField].concat(NAME_FIELDS) : NAME_FIELDS;
    im.currentRows = []; populateFeatureSelect();
    setImportStatus('Listando os talhões de ' + source.name + '…');
    // Uma única consulta: identificador, atributos de nome, tipo e área de cada feição.
    enqueue(function () {
      return ee.Dictionary({size: fc.size(), rows: fc.limit(C.maxImportFeatures)
        .toList(C.maxImportFeatures).map(function (raw) {
          var feature = ee.Feature(raw), geo = feature.geometry();
          return ee.Dictionary({k: feature.get('system:index'), type: geo.type(), area: geo.area(1),
            props: feature.toDictionary().select(fields, true)});
        })});
    }, function () { return version === im.version; }, function (result, error) {
      if (error || !result) {
        setImportStatus('Falha ao listar ' + source.name + ': ' + errorText(error) +
          '. Reabra o painel para tentar novamente.', true);
        return;
      }
      var rows = (result.rows || []).map(function (item, i) {
        return {k: item.k, i: i, name: featureName(item.props, source, item.k),
          type: item.type, area: item.area};
      });
      im.rows[key] = {rows: rows, size: result.size};
      setRows(source, rows, result.size);
      if (adoptSingle && rows.length === 1) adoptImportedRow(source, rows[0]);
    }, true);
  }
  function featureName(props, source, k) {
    var fields = source.nameField ? [source.nameField].concat(NAME_FIELDS) : NAME_FIELDS;
    for (var j = 0; j < fields.length; j++) {
      var value = props ? props[fields[j]] : null;
      if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
    return 'Feição ' + k;
  }
  function rowCompatible(row) {
    // type === null: Geometry/Feature, validados somente na adoção.
    return row.type === null || ((row.type === 'Polygon' || row.type === 'MultiPolygon') && row.area > 0);
  }
  function rowProblem(row) {
    return row.type === 'Polygon' || row.type === 'MultiPolygon' ? 'vazia' : row.type || 'sem geometria';
  }
  function rowLabel(row) {
    var ok = rowCompatible(row);
    var text = row.name + (ok && finite(row.area) ? ' · ' + number(row.area / 10000, 2) + ' ha' : '');
    if (row.duplicate) text += ' · #' + row.k;
    return ok ? text : text + ' · ' + rowProblem(row) + ' (incompatível)';
  }
  function setRows(source, rows, size) {
    var counts = {};
    rows.forEach(function (row) { counts[row.name] = (counts[row.name] || 0) + 1; });
    rows.forEach(function (row) { row.duplicate = counts[row.name] > 1; });
    S.imports.currentRows = rows.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, 'pt', {numeric: true});
    });
    S.imports.size = size;
    populateFeatureSelect();
  }
  function populateFeatureSelect() {
    var im = S.imports, rows = im.currentRows || [], u = S.ui;
    var text = String(u.importFilter.getValue() || '').trim().toLowerCase();
    var matches = rows.filter(function (row) { return !text || rowLabel(row).toLowerCase().indexOf(text) >= 0; });
    var shown = matches.slice(0, C.maxSelectItems);
    u.importFeature.setValue(null, false);
    u.importFeature.items().reset(shown.map(function (row) { return {label: rowLabel(row), value: String(row.i)}; }));
    u.importFeature.setDisabled(!shown.length);
    var current = S.aoiImport && im.source && S.aoiImport.source === im.source.key ? String(S.aoiImport.row) : null;
    if (current !== null && shown.some(function (row) { return String(row.i) === current; })) {
      u.importFeature.setValue(current, false);
    }
    if (!im.source || !rows.length) return;
    var status = rows.length + (rows.length > 1 ? ' talhões' : ' talhão') + ' em ' + im.source.name;
    if (im.size > rows.length) status += ' · listadas as primeiras ' + rows.length + ' de ' + im.size +
      ' feições (filtre a coleção no código para ver as demais)';
    if (text) status += ' · filtro: ' + matches.length;
    if (matches.length > shown.length) status += ' · exibindo ' + shown.length + '; refine o filtro';
    setImportStatus(status + '.');
  }
  function chooseImportedFeature(value) {
    var source = S.imports.source, row = null;
    if (!source || value === null || value === undefined) return;
    S.imports.currentRows.forEach(function (item) { if (String(item.i) === String(value)) row = item; });
    if (row) adoptImportedRow(source, row);
  }
  function adoptImportedRow(source, row) {
    if (!row) return;
    if (!rowCompatible(row)) {
      setImportStatus(row.name + ': geometria ' + rowProblem(row) + ' não é um talhão (use Polygon/MultiPolygon com área > 0). O talhão atual foi mantido.', true);
      return;
    }
    var geo;
    // Geometria original, sem simplificação, buffer ou reprojeção.
    if (source.kind === 'Geometry') geo = ee.Geometry(source.value);
    else if (source.kind === 'Feature') geo = ee.Feature(source.value).geometry();
    else {
      var fc = ee.FeatureCollection(source.value);
      var feature = row.k !== null && row.k !== undefined ?
        fc.filter(ee.Filter.eq('system:index', row.k)).first() : fc.toList(1, row.i).get(0);
      geo = ee.Feature(feature).geometry();
    }
    adoptAOI(geo, row.name, false, true, {source: source.key, row: row.i});
  }
  function updateSourceLayer() {
    // Contorno de todos os talhões da coleção, só com o painel aberto.
    var source = S.imports.source;
    var key = source && source.kind === 'FeatureCollection' &&
      S.ui.geometryDrawer.style().get('shown') ? source.key : null;
    eachSide(function (side) {
      if (key && side.sourceLayerKey !== key) {
        side.layers.sources.setEeObject(ee.FeatureCollection(source.value)
          .style({color: 'facc15', fillColor: '00000000', width: 1}));
        side.sourceLayerKey = key;
      }
      side.layers.sources.setShown(!!key);
    });
  }
  function pickImportedAt(coords) {
    var im = S.imports, source = im.source;
    if (S.drawingMode || !S.ui.geometryDrawer || !S.ui.geometryDrawer.style().get('shown') ||
        !source || source.kind !== 'FeatureCollection') return;
    var version = im.version, point = ee.Geometry.Point([coords.lon, coords.lat]);
    setImportStatus('Procurando o talhão no ponto clicado…');
    enqueue(function () {
      return ee.FeatureCollection(source.value).filterBounds(point).limit(1).aggregate_array('system:index');
    }, function () { return version === im.version; }, function (keys, error) {
      if (error) { setImportStatus('Falha ao identificar o talhão: ' + errorText(error), true); return; }
      if (!keys || !keys.length) {
        setImportStatus('Nenhum talhão de ' + source.name + ' no ponto clicado.', true); return;
      }
      var match = null;
      im.currentRows.forEach(function (row) { if (row.k === keys[0]) match = row; });
      if (!match) {
        // Feição além do limite listado: usa o identificador; o tipo é validado na adoção.
        match = {k: keys[0], i: -1, name: 'Feição ' + keys[0], type: null, area: null};
      } else if (filterHides(match)) {
        S.ui.importFilter.setValue('', false); populateFeatureSelect();
      }
      adoptImportedRow(source, match);
    }, true);
  }
  function filterHides(row) {
    var text = String(S.ui.importFilter.getValue() || '').trim().toLowerCase();
    return !!text && rowLabel(row).toLowerCase().indexOf(text) < 0;
  }

  // 5.2 ADOÇÃO, CONTORNO E REMOÇÃO ---------------------------------------
  function useExample() {
    finishDrawing();
    adoptAOI(ee.Geometry.Rectangle(C.example, 'EPSG:4326', false), 'Área de exemplo (DF, Brasil)', false, true);
  }
  function centerAOI() {
    if (!S.aoiReady) { setStatus('Selecione primeiro um talhão importado.', true); return; }
    // Retângulo envolvente obtido na validação: evita nova consulta da geometria.
    S.sides.left.map.centerObject(S.aoiBounds ? ee.Geometry(S.aoiBounds) : S.aoi);
  }
  function adoptAOI(candidate, name, fromDrawing, center, origin) {
    // Valida ANTES de trocar: um talhão inválido não descarta a análise atual.
    var request = ++S.aoiRequest;
    var geo = ee.Geometry(candidate);
    setStatus('Validando “' + name + '”…' + (S.aoiReady ? ' A análise atual permanece até a confirmação.' : ''));
    if (!S.aoiReady) S.ui.area.setValue(name + ' · validando…');
    enqueue(function () { return ee.Dictionary({area: geo.area(1), type: geo.type(), bounds: geo.bounds(1)}); },
      function () { return request === S.aoiRequest; }, function (result, error) {
        var valid = !error && result && finite(result.area) && result.area > 0 &&
          (result.type === 'Polygon' || result.type === 'MultiPolygon');
        if (!valid) {
          var message = error ? 'Não foi possível validar “' + name + '”: ' + errorText(error) :
            '“' + name + '” não é um talhão: use Polygon ou MultiPolygon com área > 0 (recebido: ' +
            (result && result.type ? result.type : 'vazio') + ').';
          if (S.aoiReady) { setStatus(message + ' O talhão atual foi mantido.', true); return; }
          S.aoi = null; S.aoiBounds = null; S.aoiImport = null; updateOutline(null);
          S.ui.area.setValue('Talhão inválido'); setStatus(message, true);
          return;
        }
        // A partir daqui, toda análise anterior é invalidada (regionVersion).
        S.regionVersion++;
        S.aoi = geo; S.aoiReady = true; S.areaM2 = result.area; S.aoiBounds = result.bounds;
        S.aoiImport = origin || null; S.statsCache = {};
        // GeometryLayer exige coordenadas no cliente; "Editar vértices" as busca sob demanda.
        if (!fromDrawing) setDrawingGeometry(null);
        updateOutline(geo);
        S.ui.area.setValue(name + ' · ' + number(result.area / 10000, 2) + ' ha');
        invalidateData('Talhão “' + name + '” definido.');
        populateFeatureSelect();
        if (center) centerAOI();
        searchSentinelImages();
      }, true);
  }
  function updateOutline(geo) {
    var outline = geo ? ee.FeatureCollection([ee.Feature(geo)]).style({
      color: 'ffffff', fillColor: 'ffffff00', width: 2
    }) : EMPTY;
    eachSide(function (side) {
      side.layers.outline.setEeObject(outline);
      side.layers.outline.setShown(!!geo && side.showOutline);
    });
  }
  function removeAOI() {
    S.drawingDirty = false; S.pendingDraw = null; S.aoiRequest++;
    S.regionVersion++; S.aoi = null; S.aoiReady = false; S.areaM2 = null; S.statsCache = {};
    S.aoiBounds = null; S.aoiImport = null;
    invalidateData('Nenhum talhão. Use “Selecionar talhão importado”.');
    S.preferred = {};
    setDrawingGeometry(null); updateOutline(null); finishDrawing();
    S.ui.area.setValue('Nenhum talhão selecionado');
    populateFeatureSelect();
  }

  // 6. PESQUISA REAL, PAGINAÇÃO E SELEÇÃO ----------------------------------
  function parseISO(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var milliseconds = Date.parse(value + 'T00:00:00Z');
    return finite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds : null;
  }
  function readPeriod() {
    var start = S.ui.start.getValue().trim();
    var end = S.ui.end.getValue().trim();
    var startTime = parseISO(start), endTime = parseISO(end);
    if (startTime === null || endTime === null || startTime > endTime) {
      setStatus('Informe datas válidas em AAAA-MM-DD, com início ≤ fim. A pesquisa não foi alterada.', true);
      return null;
    }
    return {start: start, end: end, startTime: startTime, endTime: endTime,
      endExclusive: new Date(endTime + 86400000).toISOString().slice(0, 10)};
  }
  function sceneId(metadata) { return C.sentinel + '/' + metadata['system:index']; }
  function sceneLabel(metadata) {
    return utc(metadata['system:time_start'], true) + ' · ' +
      (metadata.SPACECRAFT_NAME || 'Sentinel-2') + ' · ' + (metadata.MGRS_TILE || metadata['system:index']) +
      ' · nuvens ' + (finite(metadata.CLOUDY_PIXEL_PERCENTAGE) ? number(metadata.CLOUDY_PIXEL_PERCENTAGE, 1) + '%' : 'n/d');
  }
  function metadataForImage(raw) {
    return ee.Image(raw).toDictionary(['system:index', 'system:time_start',
      'SPACECRAFT_NAME', 'MGRS_TILE', 'CLOUDY_PIXEL_PERCENTAGE']);
  }
  function resetStatistics(side, text) {
    var u = side.ui;
    u.mean.setValue('NDVI médio: —'); u.coverage.setValue('Área válida: —');
    u.statDate.setValue('Imagem: ' + (side.metadata ? utc(side.metadata['system:time_start'], false) : '—'));
    u.statStatus.setValue(text);
    u.statStatus.style().set('color', C.muted);
    u.classRows.forEach(function (item) { item.percent.setValue('—'); item.bar.style().set('width', '0px'); });
  }
  function clearSelection(side, text) {
    side.selectionVersion++; side.pageVersion++;
    side.visualizationVersion++; side.visualizationRange = null;
    side.id = null; side.metadata = null; side.pageRows = [];
    side.ui.scene.setValue(null, false); side.ui.scene.items().reset([]);
    side.ui.scene.setDisabled(true); side.ui.previous.setDisabled(true); side.ui.next.setDisabled(true);
    side.ui.indexButton.setDisabled(true); side.ui.rgbButton.setDisabled(true);
    side.ui.page.setValue('Sem cenas'); side.ui.acquisition.setValue('Aquisição: —');
    side.ui.satellite.setValue('Satélite / tile: —');
    ['rgb', 'index', 'classes'].forEach(function (key) {
      side.layers[key].setShown(false); side.layers[key].setEeObject(EMPTY);
    });
    if (side.key === 'left' && !S.drawingMode) {
      S.ui.editorRGB.setShown(false); S.ui.editorRGB.setEeObject(EMPTY);
    }
    resetStatistics(side, text); updateView(side);
    if (S.kmeans.active) resetKMeans('Aguardando uma cena em cada lado…');
  }
  function invalidateData(text) {
    // Datas novas preservam resultados da mesma geometria. Toda edição,
    // adoção ou remoção de talhão incrementa regionVersion antes deste ponto.
    if (S.visualizationRegionVersion !== S.regionVersion) {
      S.visualizationRegionVersion = S.regionVersion;
      S.visualizationCache = {}; S.visualizationPending = {}; S.visualizationOrder = [];
    }
    S.preferred = S.preferred || {};
    eachSide(function (side) {
      if (side.metadata) S.preferred[side.key] = side.metadata;
      clearSelection(side, text);
    });
    S.searchVersion++; S.searchBusy = false; S.collection = null; S.count = 0;
    S.pageCache = {}; S.pagePending = {};
    S.indexJobs = {}; S.climateJob = null;
    clearCharts(text);
    setStatus(text);
    if (S.ui.search) { S.ui.search.setDisabled(false); S.ui.search.setLabel('Pesquisar'); }
  }
  function searchSentinelImages() {
    if (!S.aoiReady) { setStatus('Selecione um talhão em “Selecionar talhão importado”.', true); return; }
    var period = readPeriod();
    if (!period) return;
    invalidateData('Pesquisando Sentinel-2…');
    S.period = period; S.searchBusy = true;
    S.ui.period.setValue(period.start + ' a ' + period.end + ' · datas inclusivas');
    S.ui.search.setDisabled(true); S.ui.search.setLabel('Buscando…');
    var version = S.searchVersion;
    var collection = ee.ImageCollection(C.sentinel).filterBounds(S.aoi)
      .filterDate(period.start, period.endExclusive).map(function (raw) {
        var image = ee.Image(raw);
        return image.set('_order', ee.Date(image.get('system:time_start')).format('yyyyMMddHHmmssSSS')
          .cat('_').cat(ee.String(image.get('system:index'))));
      }).sort('_order');
    S.collection = collection;
    var preferred = S.preferred || {};
    function retained(key) {
      return preferred[key] ? collection.filter(ee.Filter.eq('system:index',
        preferred[key]['system:index'])).toList(1).map(metadataForImage) : ee.List([]);
    }
    enqueue(function () { return ee.Dictionary({count: collection.size(),
      left: retained('left'), right: retained('right')}); },
      function () { return version === S.searchVersion && S.aoiReady; }, function (result, error) {
        S.searchBusy = false; S.ui.search.setDisabled(false); S.ui.search.setLabel('Pesquisar');
        if (error || !result) {
          S.collection = null;
          setStatus('Falha na pesquisa: ' + errorText(error) + '. Clique em Pesquisar para tentar novamente.', true);
          return;
        }
        S.count = result.count || 0;
        if (!S.count) {
          eachSide(function (side) { clearSelection(side, 'Nenhuma cena neste intervalo.'); });
          setStatus('Nenhuma cena Sentinel-2 intersecta o talhão neste intervalo. Ajuste as datas.');
        } else {
          setStatus(S.count + ' cenas encontradas · todas as nuvens incluídas · arraste o divisor para comparar.');
          eachSide(function (side) {
            var kept = result[side.key] && result[side.key][0];
            if (kept) selectScene(side, kept);
            var page = side.key === 'left' ? 0 : Math.floor((S.count - 1) / C.pageSize);
            loadSidePage(side, page, kept ? null : side.key === 'left' ? 'first' : 'last');
          });
        }
        if (S.chartsOpen) refreshCharts();
      }, true);
  }
  function fetchPage(page, done) {
    if (S.pageCache[page]) { done(S.pageCache[page]); return; }
    if (S.pagePending[page]) { S.pagePending[page].push(done); return; }
    S.pagePending[page] = [done];
    var version = S.searchVersion, collection = S.collection;
    enqueue(function () { return collection.toList(C.pageSize, page * C.pageSize).map(metadataForImage); },
      function () { return version === S.searchVersion; }, function (rows, error) {
        var listeners = S.pagePending[page] || [];
        delete S.pagePending[page];
        if (!error && rows) S.pageCache[page] = rows;
        listeners.forEach(function (listener) { listener(rows, error); });
      }, true);
  }
  function populateSceneMenu(side) {
    var items = side.pageRows.map(function (item) { return {label: sceneLabel(item), value: sceneId(item)}; });
    var contains = items.some(function (item) { return item.value === side.id; });
    if (side.metadata && !contains) items.unshift({label: 'Atual · ' + sceneLabel(side.metadata), value: side.id});
    side.ui.scene.setValue(null, false);
    side.ui.scene.items().reset(items);
    if (side.id) side.ui.scene.setValue(side.id, false);
    side.ui.scene.setDisabled(!items.length);
  }
  function loadSidePage(side, page, autoSelect) {
    var last = Math.floor((S.count - 1) / C.pageSize);
    if (!S.collection || !S.count || page < 0 || page > last) return;
    var version = ++side.pageVersion;
    side.ui.scene.setDisabled(true); side.ui.previous.setDisabled(true); side.ui.next.setDisabled(true);
    side.ui.page.setValue('Carregando lista…');
    fetchPage(page, function (rows, error) {
      if (version !== side.pageVersion) return;
      if (error || !rows) {
        side.ui.page.setValue('Falha na lista');
        setStatus('Falha ao listar cenas: ' + errorText(error) + '. Refaça a pesquisa.', true);
        return;
      }
      side.page = page; side.pageRows = rows;
      if (autoSelect && rows.length) selectScene(side, rows[autoSelect === 'last' ? rows.length - 1 : 0]);
      populateSceneMenu(side);
      side.ui.page.setValue((page + 1) + '/' + (last + 1) + ' · ' + S.count + ' cenas');
      side.ui.previous.setDisabled(page <= 0); side.ui.next.setDisabled(page >= last);
    });
  }
  function selectScene(side, metadata) {
    side.selectionVersion++;
    side.metadata = metadata; side.id = sceneId(metadata);
    S.preferred[side.key] = metadata;
    populateSceneMenu(side);
    side.ui.acquisition.setValue('Aquisição: ' + utc(metadata['system:time_start'], true));
    side.ui.satellite.setValue((metadata.SPACECRAFT_NAME || 'Sentinel-2') + ' · tile ' + (metadata.MGRS_TILE || 'n/d') +
      ' · nuvens ' + (finite(metadata.CLOUDY_PIXEL_PERCENTAGE) ? number(metadata.CLOUDY_PIXEL_PERCENTAGE, 1) + '%' : 'n/d'));
    side.ui.indexButton.setDisabled(false); side.ui.rgbButton.setDisabled(false);
    renderRGB(side); renderIndex(side);
    // Classes são categóricas: sempre pixels nativos, sem interpolação.
    side.layers.classes.setEeObject(classifyNDVI(sceneIndex(side.id, 'NDVI')).clip(S.aoi));
    updateView(side); updateVegetationPanel(side);
    // Selecionar uma cena só redesenha os marcadores; não recalcula a série.
    if (S.chartsOpen) renderIndexJob(S.indexJobs[S.chartIndex], true);
    if (S.kmeans.active) S.ui.kmeansSchedule();
  }
  function renderRGB(side) {
    var rgb = visualImage(sceneProducts(side.id).rgb);
    side.layers.rgb.setEeObject(rgb.clip(S.aoi));
    side.layers.rgb.setName('RGB · ' + utc(side.metadata['system:time_start'], false));
    if (side.key === 'left') {
      S.ui.editorRGB.setEeObject(rgb);
      S.ui.editorRGB.setShown(true);
    }
  }
  function setSmoothing(mode) {
    if (!SMOOTHING[mode] || mode === S.smoothing) return;
    S.smoothing = mode;
    // Troca só os objetos das camadas RGB/índice. Escalas de cor, classes,
    // estatísticas e séries não são recalculadas (dependem só dos pixels nativos).
    eachSide(function (side) {
      if (side.id && S.aoiReady) {
        renderRGB(side);
        if (visualization(side.index, side.visualizationRange)) {
          side.layers.index.setEeObject(visualImage(sceneIndex(side.id, side.index)).clip(S.aoi));
        }
      }
      updateView(side);
    });
    setStatus('Suavização visual: ' + SMOOTHING[mode].label +
      (SMOOTHING[mode].method ? ' (' + SMOOTHING[mode].method + ', só exibição).' : ' (pixels nativos).'));
  }
  function renderIndex(side) {
    if (!side.id || !S.aoi) return;
    var id = side.id, key = side.index, version = S.regionVersion, region = S.aoi;
    var selection = side.selectionVersion, request = ++side.visualizationVersion;
    var index = sceneIndex(id, key);
    side.visualizationRange = {key: key, source: 'loading', note: 'calculando min/máx'};
    // Não mostra a cena anterior nem usa uma escala fixa durante a redução.
    side.layers.index.setShown(false);
    side.layers.index.setEeObject(EMPTY);
    side.layers.index.setName(key + ' · ' + utc(side.metadata['system:time_start'], false));
    updateView(side);
    if (!S.aoiReady) return;
    fetchVisualizationRange(id, key, index, function (limits) {
      if (!S.aoiReady || version !== S.regionVersion || selection !== side.selectionVersion ||
          request !== side.visualizationVersion || id !== side.id || key !== side.index) return;
      side.visualizationRange = limits;
      var params = visualization(key, limits);
      if (params) {
        // EMPTY possui todas as bandas: instala primeiro a nova escala/banda
        // e só então a imagem real, evitando parâmetros de outra seleção.
        side.layers.index.setVisParams(params);
        side.layers.index.setEeObject(visualImage(index).clip(region));
      }
      // Respeita RGB/classes se o usuário mudou de representação durante a redução.
      updateView(side);
    });
  }
  function setView(side, view) {
    if (!side.id) return;
    side.showRGB = view === 'rgb'; side.showIndex = view === 'index'; side.showClasses = false;
    updateView(side);
  }
  function updateView(side) {
    var hasScene = !!side.id;
    side.layers.rgb.setShown(hasScene && side.showRGB);
    side.layers.index.setShown(hasScene && side.showIndex &&
      visualization(side.index, side.visualizationRange) !== null);
    side.layers.classes.setShown(hasScene && side.showClasses);
    side.layers.outline.setShown(!!S.aoi && side.showOutline);
    if (side.ui.checks) {
      side.ui.checks.rgb.setValue(side.showRGB, false);
      side.ui.checks.index.setValue(side.showIndex, false);
      side.ui.checks.classes.setValue(side.showClasses, false);
      side.ui.checks.outline.setValue(side.showOutline, false);
    }
    var mode = !hasScene ? 'sem imagem' : side.showClasses ? 'Classes NDVI' :
      side.showIndex ? side.index : side.showRGB ? 'RGB' : 'Camadas ocultas';
    side.ui.badge.setValue((hasScene ? utc(side.metadata['system:time_start'], false) + ' · ' : '') + mode);
    side.ui.current.setValue(hasScene ? 'Cena: ' + side.metadata['system:index'] : 'Nenhuma cena selecionada');
    side.ui.indexButton.style().set({backgroundColor: mode === side.index ? C.blue : '#f1f5f9',
      color: mode === side.index ? '#ffffff' : C.ink});
    side.ui.rgbButton.style().set({backgroundColor: mode === 'RGB' ? C.blue : '#f1f5f9',
      color: mode === 'RGB' ? '#ffffff' : C.ink});
    updateLegend(side, mode);
  }
  function smoothingNote() {
    var mode = SMOOTHING[S.smoothing];
    return mode.method ? 'Exibição ' + mode.label.toLowerCase() + ' (' + mode.method +
      '): só visual; resolução real inalterada; cálculos nos pixels nativos.' :
      'Exibição: pixels nativos, sem interpolação.';
  }
  function updateLegend(side, mode) {
    var u = side.ui;
    if (side.legendMode !== mode) {
      side.legendMode = mode;
      u.legend.clear();
      if (INDEX[mode]) {
        var config = INDEX[mode];
        u.legend.add(label(config.meaning, {fontSize: '9px', color: C.muted}));
        u.legend.add(ui.Thumbnail({image: ee.Image.pixelLonLat().select('longitude'),
          params: {bbox: [0, 0, 1, 0.1], dimensions: '235x8', min: 0, max: 1,
            palette: config.palette, format: 'png'}, style: {height: '8px', width: '235px', margin: '0'}}));
        u.legendMin = label('', {fontSize: '9px', stretch: 'horizontal'});
        u.legendMax = label('', {fontSize: '9px', textAlign: 'right'});
        u.legend.add(row([u.legendMin, u.legendMax]));
      }
      u.legendNote = label('', {fontSize: '9px', color: C.muted, whiteSpace: 'pre-wrap'});
      u.legend.add(u.legendNote);
    }
    // Atualiza só os textos: não recria a barra de cores após cada resposta.
    var note = '';
    if (INDEX[mode]) {
      var range = side.visualizationRange && side.visualizationRange.key === mode ?
        side.visualizationRange : {key: mode, source: 'loading', note: 'calculando a escala'};
      var ready = visualization(mode, range) !== null;
      u.legendMin.setValue(ready ? formatVisualizationBound(range.min, range.max) : '—');
      u.legendMax.setValue(ready ? formatVisualizationBound(range.max, range.min) : '—');
      note = 'Sem unidade · ' + INDEX[mode].scale + ' m · ' + range.note + '\n' + smoothingNote();
    } else if (mode === 'RGB') {
      note = 'RGB: B4 / B3 / B2 · refletância 0–0,30 · 10 m\n' + smoothingNote();
    } else if (mode === 'Classes NDVI') {
      note = 'Classes em pixels nativos, sem interpolação.\nCores e intervalos no cartão de distribuição do NDVI.';
    }
    u.legendNote.setValue(note);
  }

  // 6.1 K-MEANS (3 CLASSES) E MAPA DE DIFERENÇAS ---------------------------
  // Um único modelo é treinado com amostras das duas cenas (esquerda e direita)
  // e aplicado às duas; os grupos são renumerados pelo NDVI médio (1 = menor),
  // então a classe 2 tem o mesmo significado nas duas datas. A diferença é
  // classe(data mais recente) − classe(data mais antiga): perda, igual ou ganho.
  function legendRow(color, text) {
    return row([ui.Panel({style: {backgroundColor: '#' + color, width: '12px', height: '12px',
      margin: '2px 6px 0 0'}}), label(text, {fontSize: '10px', stretch: 'horizontal'})]);
  }
  function createKMeansPanel() {
    var u = S.ui;
    u.kmeansStatus = label('', {fontSize: '10px', color: C.muted, whiteSpace: 'pre-wrap'});
    u.kmeansClassesButton = button('Classes por data', function () { setKMeansView('classes'); }, true,
      {stretch: 'horizontal'});
    u.kmeansChangeButton = button('Mapa de diferenças', function () { setKMeansView('change'); }, false,
      {stretch: 'horizontal'});
    u.kmeansClassLegend = ui.Panel(KMEANS.classNames.map(function (name, i) {
      return legendRow(KMEANS.classColors[i], name);
    }), null, {margin: '2px 0', padding: '0'});
    u.kmeansChangeRows = KMEANS.changeNames.map(function (name, i) {
      var value = label('—', {fontSize: '10px', fontWeight: 'bold', textAlign: 'right'});
      return {value: value, widget: row([ui.Panel({style: {backgroundColor: '#' + KMEANS.changeColors[i],
        width: '12px', height: '12px', margin: '2px 6px 0 0'}}),
        label(name, {fontSize: '10px', stretch: 'horizontal'}), value])};
    });
    u.kmeansChangeLegend = ui.Panel(u.kmeansChangeRows.map(function (item) { return item.widget; }),
      null, {margin: '2px 0', padding: '0', shown: false});
    u.kmeansCard = card([
      label('K-means · 3 classes', {fontWeight: 'bold'}),
      u.kmeansStatus,
      row([u.kmeansClassesButton, u.kmeansChangeButton]),
      u.kmeansClassLegend, u.kmeansChangeLegend,
      label('Bandas B2, B3, B4, B8, B11, B12 (B11/B12 de 20 m amostradas na grade de 10 m). ' +
        'Modelo único para as duas datas; classes ordenadas pelo NDVI médio de cada grupo.',
        {fontSize: '9px', color: C.muted, whiteSpace: 'pre-wrap'})
    ], {shown: false, margin: '5px 0 0'});
    u.kmeansSchedule = ui.util.debounce(refreshKMeans, 300);
  }
  function setKMeansStatus(text, error) {
    S.ui.kmeansStatus.setValue(text);
    S.ui.kmeansStatus.style().set('color', error ? C.danger : C.muted);
  }
  function updateKMeansView() {
    var K = S.kmeans, change = K.view === 'change';
    eachSide(function (side) {
      side.layers.kmeans.setShown(K.active && K.ready && !change);
      side.layers.change.setShown(K.active && K.ready && change);
    });
    S.ui.kmeansClassLegend.style().set('shown', !change);
    S.ui.kmeansChangeLegend.style().set('shown', change);
    S.ui.kmeansClassesButton.style().set({backgroundColor: change ? '#f1f5f9' : C.blue,
      color: change ? C.ink : '#ffffff'});
    S.ui.kmeansChangeButton.style().set({backgroundColor: change ? C.blue : '#f1f5f9',
      color: change ? '#ffffff' : C.ink});
  }
  function setKMeansView(view) { S.kmeans.view = view; updateKMeansView(); }
  function resetKMeans(text, error) {
    // Cancela respostas pendentes e retira as camadas da cena/talhão anterior.
    S.kmeans.version++; S.kmeans.ready = false;
    eachSide(function (side) {
      side.layers.kmeans.setEeObject(EMPTY); side.layers.change.setEeObject(EMPTY);
    });
    S.ui.kmeansChangeRows.forEach(function (item) { item.value.setValue('—'); });
    setKMeansStatus(text, error);
    updateKMeansView();
  }
  function toggleKMeans() {
    var K = S.kmeans;
    K.active = !K.active;
    S.ui.kmeansButton.setLabel(K.active ? 'Desativar K-means' : 'Ativar K-means');
    S.ui.kmeansButton.style().set({backgroundColor: K.active ? C.blue : '#f1f5f9',
      color: K.active ? '#ffffff' : C.ink});
    S.ui.kmeansCard.style().set('shown', K.active);
    if (K.active) refreshKMeans(); else resetKMeans('');
  }
  function kmeansInput(id) {
    return sceneProducts(id).raw.select(KMEANS.bands).multiply(0.0001);
  }
  function refreshKMeans() {
    var K = S.kmeans;
    if (!K.active) return;
    var left = S.sides.left, right = S.sides.right;
    if (!S.aoiReady || !left.id || !right.id) {
      resetKMeans('Selecione um talhão e uma cena em cada lado.'); return;
    }
    resetKMeans('Treinando o K-means com as duas cenas…');
    var version = K.version, regionVersion = S.regionVersion, region = S.aoi;
    var leftId = left.id, rightId = right.id;
    var sameScene = leftId === rightId;
    // A cena mais antiga é a referência da diferença (empate: lado esquerdo).
    var early = left.metadata['system:time_start'] <= right.metadata['system:time_start'] ? left : right;
    var late = early === left ? right : left;
    var inputs = {left: kmeansInput(leftId), right: kmeansInput(rightId)};
    function samples(image, seed) {
      return image.sample({region: region, scale: 10, numPixels: KMEANS.samplesPerDate,
        seed: seed, tileScale: C.tileScale, geometries: false});
    }
    var training = samples(inputs.left, 1).merge(samples(inputs.right, 2));
    var clusterer = ee.Clusterer.wekaKMeans(KMEANS.clusters).train(training, KMEANS.bands);
    function current() {
      return version === K.version && K.active && regionVersion === S.regionVersion &&
        left.id === leftId && right.id === rightId;
    }
    enqueue(function () {
      // Médias de B4 e B8 por grupo, para ordenar os grupos pelo NDVI médio.
      return ee.Dictionary({size: training.size(), groups: ee.Dictionary(training.cluster(clusterer)
        .reduceColumns(ee.Reducer.mean().repeat(2).group({groupField: 2, groupName: 'cluster'}),
          ['B4', 'B8', 'cluster'])).get('groups')});
    }, current, function (result, error) {
      if (error || !result) {
        resetKMeans('Falha no K-means: ' + errorText(error) +
          '. Verifique se as duas cenas têm pixels válidos no talhão.', true);
        return;
      }
      var groups = (result.groups || []).map(function (group) {
        var red = group.mean && group.mean[0], nir = group.mean && group.mean[1];
        var ndvi = finite(red) && finite(nir) && red + nir !== 0 ? (nir - red) / (nir + red) : null;
        return {cluster: group.cluster, ndvi: ndvi};
      }).filter(function (group) { return finite(group.cluster) && group.ndvi !== null; });
      if (groups.length < KMEANS.clusters) {
        resetKMeans('O K-means formou só ' + groups.length + ' grupo(s) distinto(s) com ' +
          (result.size || 0) + ' amostras. O talhão pode ser pequeno ou homogêneo demais.', true);
        return;
      }
      groups.sort(function (a, b) { return a.ndvi - b.ndvi; });
      var from = groups.map(function (group) { return group.cluster; });
      var to = groups.map(function (group, i) { return i + 1; });
      function classes(key) {
        return inputs[key].cluster(clusterer).remap(from, to).rename('kclasse');
      }
      var byKey = {left: classes('left'), right: classes('right')};
      var delta = byKey[late.key].subtract(byKey[early.key]);
      var change = delta.gt(0).add(delta.gte(0)).add(1).rename('mudanca');
      // Classes são categóricas: sem suavização visual.
      eachSide(function (side) {
        side.layers.kmeans.setEeObject(byKey[side.key].clip(region));
        side.layers.change.setEeObject(change.clip(region));
      });
      K.ready = true;
      updateKMeansView();
      setKMeansStatus('Classes prontas (' + result.size + ' amostras). Diferença: ' +
        utc(late.metadata['system:time_start'], false) + ' − ' + utc(early.metadata['system:time_start'], false) +
        (sameScene ? '\nAtenção: os dois lados mostram a mesma cena; não há diferença temporal.' : '') +
        '\nCalculando áreas…', sameScene);
      var area = ee.Image.pixelArea();
      var stack = area.updateMask(change.mask()).rename('total');
      [1, 2, 3].forEach(function (code) {
        stack = stack.addBands(area.updateMask(change.eq(code)).rename('m' + code));
      });
      var projection = sceneProducts(early.id).raw.select('B4').projection();
      enqueue(function () { return reduceOnGrid(stack, projection, region); }, current, function (sums, err) {
        var base = S.ui.kmeansStatus.getValue().replace('\nCalculando áreas…', '');
        if (err || !sums) { setKMeansStatus(base + '\nFalha nas áreas: ' + errorText(err), true); return; }
        var total = finite(sums.total) ? sums.total : 0;
        S.ui.kmeansChangeRows.forEach(function (item, i) {
          var value = sums['m' + (i + 1)];
          item.value.setValue(finite(value) && total > 0 ?
            number(value / 10000, 2) + ' ha · ' + number(value / total * 100, 1) + '%' : '—');
        });
        setKMeansStatus(base + (total > 0 ? '' : '\nSem pixels válidos nas duas cenas.'), sameScene || !(total > 0));
      }, true);
    }, true);
  }

  // 7. ESTATÍSTICAS INDEPENDENTES, COM CACHE POR CENA E AOI -----------------
  function statsKey(id) { return S.regionVersion + '|' + id; }
  function updateVegetationPanel(side) {
    if (!side.id || !S.aoiReady) return;
    resetStatistics(side, 'Calculando áreas a 10 m…');
    side.statsVersion = (side.statsVersion || 0) + 1;
    var attempt = side.statsVersion;
    var selection = side.selectionVersion, id = side.id, version = S.regionVersion;
    function apply(value, error) {
      if (attempt !== side.statsVersion || selection !== side.selectionVersion || version !== S.regionVersion || id !== side.id) return;
      var u = side.ui;
      if (error || !value) {
        u.statStatus.setValue('Falha no cálculo a 10 m. Use ↻ para tentar novamente.');
        u.statStatus.style().set('color', C.danger);
        setStatus('Estatísticas: ' + errorText(error) + '. A escala foi mantida; reduza a área se necessário.', true);
        return;
      }
      u.mean.setValue('NDVI médio: ' + number(value.mean, 3));
      u.coverage.setValue('Área válida: ' + number(value.coverage, 2) + '% · ' + number(value.validArea / 10000, 2) + ' ha');
      if (!(value.validArea > 0)) {
        u.statStatus.setValue('Sem pixels NDVI válidos nesta cena / talhão.');
        return;
      }
      var sum = 0;
      u.classRows.forEach(function (item, i) {
        var percent = value.percentages[i];
        item.percent.setValue(number(percent, 2) + '%');
        item.bar.style().set('width', (C.statBarPixels * Math.max(0, Math.min(100, percent)) / 100).toFixed(2) + 'px');
        sum += percent;
      });
      u.statStatus.setValue('Soma: ' + number(sum, 2) + '% · grade 10 m' +
        (value.coverage < 99.5 ? ' · cobertura parcial' : ''));
      u.statStatus.style().set('color', Math.abs(sum - 100) > 0.05 ? C.danger : C.muted);
    }
    var key = statsKey(id), entry = S.statsCache[key];
    if (entry) {
      if (entry.ready) apply(entry.value, entry.error); else entry.listeners.push(apply);
      return;
    }
    entry = {ready: false, listeners: [apply]}; S.statsCache[key] = entry;
    var region = S.aoi;
    enqueue(function () { return calculateClassAreas(sceneProducts(id).raw, region); },
      function () { return version === S.regionVersion; }, function (value, error) {
        entry.ready = true; entry.value = value; entry.error = error;
        entry.listeners.forEach(function (listener) { listener(value, error); });
        entry.listeners = [];
      }, true);
  }

  // 8. PAINEL DE GRÁFICOS E SÉRIES REAIS -----------------------------------
  function createChartPanel() {
    var u = S.ui;
    u.chartToggle = button('▸ Série temporal e clima', function () { setChartsOpen(!S.chartsOpen); });
    u.chartIndex = ui.Select({items: indexItems(), value: S.chartIndex,
      onChange: chooseChartIndex, style: {width: '235px', fontSize: '10px', margin: '2px 4px'}});
    u.period = label('O período dos gráficos acompanha a pesquisa', {stretch: 'horizontal', color: C.muted});
    var update = button('Atualizar dados', function () {
      if (!S.aoiReady) { setStatus('Selecione primeiro um talhão.', true); return; }
      // Com a mesma pesquisa, séries que falharam continuam do último lote concluído.
      if (S.collection && !S.searchBusy && resumeFailedSeries()) {
        setStatus('Retomando as séries a partir do último lote concluído…');
        if (S.chartsOpen) refreshCharts(); else setChartsOpen(true);
        return;
      }
      searchSentinelImages(); setChartsOpen(true);
    });
    u.chartCards = {};
    ['index', 'temperature', 'precipitation'].forEach(function (key) {
      var titles = {index: 'Índice espectral · média espacial',
        temperature: 'Temperatura do ar a 2 m · °C', precipitation: 'Precipitação diária acumulada · mm'};
      var status = label('Defina um talhão e um período.', {fontSize: '10px', color: C.muted});
      var host = ui.Panel({style: {height: '200px', stretch: 'horizontal', margin: '0', padding: '0'}});
      var panel = ui.Panel({widgets: [label(titles[key], {fontWeight: 'bold'}), status, host],
        style: {stretch: 'both', width: '33.33%', margin: '3px', padding: '5px',
          backgroundColor: '#ffffff', border: '1px solid ' + C.line, borderRadius: '5px'}});
      u.chartCards[key] = {panel: panel, status: status, host: host};
    });
    u.chartContent = row([u.chartCards.index.panel, u.chartCards.temperature.panel,
      u.chartCards.precipitation.panel], {shown: false, height: '269px', stretch: 'horizontal',
        backgroundColor: C.background, margin: '0', padding: '2px'});
    u.chartPanel = ui.Panel({widgets: [row([u.chartToggle, u.chartIndex, u.period, update],
      {stretch: 'horizontal', padding: '2px 8px', margin: '0', backgroundColor: '#f8fafc'}), u.chartContent],
      style: {stretch: 'horizontal', padding: '0', margin: '0'}});
  }
  function clearCharts(text) {
    if (!S.ui.chartCards) return;
    Object.keys(S.ui.chartCards).forEach(function (key) {
      S.ui.chartCards[key].host.clear(); S.ui.chartCards[key].status.setValue(text);
    });
  }
  function setChartsOpen(open) {
    if (open !== S.chartsOpen) eachSide(function (side) {
      if (open) {
        side.controlsBeforeCharts = side.ui.controlBody.style().get('shown');
        side.ui.controlBody.style().set('shown', false); side.ui.controlToggle.setLabel('+');
      } else {
        var shown = side.controlsBeforeCharts !== false;
        side.ui.controlBody.style().set('shown', shown); side.ui.controlToggle.setLabel(shown ? '−' : '+');
      }
    });
    S.chartsOpen = open;
    S.ui.chartContent.style().set('shown', open);
    S.ui.chartToggle.setLabel((open ? '▾' : '▸') + ' Série temporal e clima');
    updateToolStyles();
    if (open) refreshCharts();
  }
  function chooseChartIndex(key) {
    if (!INDEX[key]) return;
    S.chartIndex = key;
    if (S.ui.chartIndex.getValue() !== key) S.ui.chartIndex.setValue(key, false);
    if (S.chartsOpen && !S.searchBusy) buildIndexTimeSeries();
  }
  function refreshCharts() {
    if (!S.chartsOpen) return;
    if (!S.aoiReady || !S.period || !S.collection || S.searchBusy) {
      clearCharts(S.searchBusy ? 'Aguardando a pesquisa…' : 'Defina um talhão e pesquise um período.');
      return;
    }
    buildIndexTimeSeries();
    buildClimateSeries();
  }
  function progress(job, unit) {
    if (job.error) return 'Falha após ' + job.offset + '/' + job.total + ' ' + unit + ': ' +
      errorText(job.error) + ' · Atualizar dados retoma deste ponto.';
    return job.offset + '/' + job.total + ' ' + unit + (job.complete ? '' : ' · carregando…') +
      (job.failures ? ' · nova tentativa ' + job.failures + '/' + C.batchRetries : '');
  }
  function retryBatch(job, resume) {
    // Falhas transitórias (tempo esgotado, excesso de consultas) repetem só o
    // lote que falhou, com espera crescente; o progresso já obtido é mantido.
    job.failures = (job.failures || 0) + 1;
    if (job.failures > C.batchRetries) { job.failures = 0; return false; }
    job.busy = true;
    ui.util.setTimeout(function () { job.busy = false; resume(); }, C.retryDelayMs * job.failures);
    return true;
  }
  function resumeFailedSeries() {
    var resumed = false;
    Object.keys(S.indexJobs).forEach(function (key) {
      var job = S.indexJobs[key];
      if (job.error) { job.error = null; resumed = true; }
    });
    var climate = S.climateJob;
    if (climate && climate.error) {
      // Sem cabeçalho (metadados), a série climática é reconstruída.
      if (climate.headerReady) climate.error = null; else S.climateJob = null;
      resumed = true;
    }
    return resumed;
  }
  function buildIndexTimeSeries() {
    var key = S.chartIndex;
    if (!S.collection || !S.aoiReady || S.searchBusy) return;
    var job = S.indexJobs[key];
    if (!job) {
      job = {key: key, version: S.searchVersion, collection: S.collection, region: S.aoi,
        total: S.count, offset: 0, rows: [], busy: false, complete: S.count === 0, error: null};
      S.indexJobs[key] = job;
    }
    renderIndexJob(job, true);
    nextSpectralBatch(job);
  }
  function nextSpectralBatch(job) {
    if (job.busy || job.complete || job.error || !S.chartsOpen || S.chartIndex !== job.key) return;
    job.busy = true;
    var amount = Math.min(C.spectralBatch, job.total - job.offset), offset = job.offset;
    // Toda cena usa summarizeIndex: mesma definição de pixel válido do cartão NDVI.
    enqueue(function () {
      return job.collection.toList(amount, offset).map(function (raw) {
        return summarizeIndex(ee.Image(raw), job.key, job.region);
      });
    }, function () { return job.version === S.searchVersion && S.indexJobs[job.key] === job; },
      function (rows, error) {
        job.busy = false;
        if (!error && rows && rows.length === amount) {
          job.failures = 0; job.rows = job.rows.concat(rows); job.offset += rows.length;
          job.complete = job.offset >= job.total;
        } else if (!retryBatch(job, function () { nextSpectralBatch(job); })) {
          job.error = error || 'Lote de cenas incompleto';
        }
        if (S.chartIndex === job.key && S.chartsOpen) renderIndexJob(job);
        nextSpectralBatch(job);
      });
  }
  function chartOptions(yTitle, color) {
    return {fontName: 'Arial', fontSize: 10, backgroundColor: '#ffffff',
      chartArea: {left: 49, right: 12, top: 14, bottom: 43},
      hAxis: {title: 'Data (UTC)', format: 'dd/MM', gridlines: {count: 5},
        viewWindow: {min: chartDate(S.period.startTime), max: chartDate(S.period.endTime + 86400000)}},
      vAxis: {title: yTitle, gridlines: {color: '#edf2f7'}},
      colors: [color], legend: {position: 'none'}, pointSize: 3, lineWidth: 1,
      interpolateNulls: false};
  }
  function renderIndexJob(job, force) {
    if (!job || job.version !== S.searchVersion || job.key !== S.chartIndex || !S.chartsOpen) return;
    var target = S.ui.chartCards.index;
    var validCount = job.rows.filter(function (item) { return finite(item.mean); }).length;
    target.status.setValue(job.total ? progress(job, 'cenas') + ' · ' + INDEX[job.key].scale + ' m · sem máscara de nuvens' :
      'Nenhuma cena Sentinel-2 neste intervalo.');
    if (!force && job.renderedCount && !job.complete && !job.error && job.rows.length - job.renderedCount < 16) return;
    job.renderedCount = job.rows.length;
    target.host.clear();
    if (!validCount) {
      target.host.add(label(job.rows.length ? 'Sem pixels válidos nas cenas processadas.' : 'Aguardando dados reais…', {color: C.muted}));
      return;
    }
    var left = S.sides.left.id, right = S.sides.right.id;
    var table = {cols: [
      {id: 'date', label: 'Aquisição (UTC)', type: 'datetime'},
      {id: 'mean', label: job.key, type: 'number'},
      {type: 'string', role: 'tooltip'},
      {id: 'left', label: 'Esquerda', type: 'number'},
      {type: 'string', role: 'tooltip'},
      {id: 'right', label: 'Direita', type: 'number'},
      {type: 'string', role: 'tooltip'}
    ], rows: job.rows.map(function (item) {
      var id = C.sentinel + '/' + item.index;
      var value = finite(item.mean) ? item.mean : null;
      var coverage = item.totalArea > 0 ? item.validArea / item.totalArea * 100 : null;
      var tip = utc(item.time, true) + '\n' + job.key + ': ' + number(value, 4) + '\n' + item.index +
        '\nÁrea válida: ' + number(coverage, 2) + '%\nNuvens da cena: ' + number(item.cloud, 1) + '%';
      return {c: [{v: chartDate(item.time)}, {v: value}, {v: tip},
        {v: id === left ? value : null}, {v: 'Esquerda\n' + tip},
        {v: id === right ? value : null}, {v: 'Direita\n' + tip}]};
    })};
    var options = chartOptions(job.key + ' (sem unidade)', C.green);
    options.colors = [C.green, C.blue, '#d97706'];
    options.legend = {position: 'bottom', textStyle: {fontSize: 9}};
    options.series = {1: {lineWidth: 0, pointSize: 8, pointShape: 'circle'},
      2: {lineWidth: 0, pointSize: 5, pointShape: 'diamond'}};
    var chart = ui.Chart(table).setChartType('LineChart').setOptions(options);
    chart.style().set({stretch: 'both', height: '200px', margin: '0'});
    target.host.add(chart);
  }

  // Clima: grade nativa + pesos vetoriais, evitando nulos artificiais em talhões
  // menores que 0,5% de um pixel do ERA5 (limiar de redutores raster ponderados).
  function climateSamplingGrid(region, projection, rawGrid) {
    var cells = rawGrid || ee.Geometry(region).coveringGrid(projection);
    return ee.FeatureCollection(cells).map(function (raw) {
      var cell = ee.Feature(raw);
      var weight = cell.geometry().intersection(region, 1).area(1);
      return ee.Feature(cell.geometry().centroid(1), {weight_m2: weight});
    }).filter(ee.Filter.gt('weight_m2', 0));
  }
  function summarizeClimate(raw, job) {
    var image = ee.Image(raw);
    var temperature = image.select('temperature_2m').subtract(273.15).rename('temperature');
    var precipitation = image.select('total_precipitation_sum').multiply(1000).rename('precipitation');
    // Precipitação já é o total do dia na fonte: não se aplica média temporal.
    // Os dois agregados espaciais usam a área de interseção como peso.
    var samples = temperature.addBands(precipitation).sampleRegions({
      collection: job.grid, properties: ['weight_m2'], projection: job.projection,
      tileScale: C.tileScale, geometries: false
    }).filter(ee.Filter.notNull(['temperature', 'precipitation', 'weight_m2'])).map(function (rawSample) {
      var sample = ee.Feature(rawSample), weight = ee.Number(sample.get('weight_m2'));
      return sample.set({tw: ee.Number(sample.get('temperature')).multiply(weight),
        pw: ee.Number(sample.get('precipitation')).multiply(weight)});
    });
    var reduced = samples.reduceColumns(ee.Reducer.sum().repeat(3), ['tw', 'pw', 'weight_m2']);
    var rawSums = ee.Dictionary(reduced).get('sum', ee.List([0, 0, 0]));
    var sums = ee.List(ee.Algorithms.If(ee.Algorithms.IsEqual(rawSums, null),
      ee.List([0, 0, 0]), rawSums)).cat(ee.List([0, 0, 0]));
    var values = ee.Dictionary({tw: sums.get(0), pw: sums.get(1), weight: sums.get(2)});
    var weight = zeroIfNull(values, 'weight');
    var hasTemperature = ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(sums.get(0), null), 0, 1));
    var hasPrecipitation = ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(sums.get(1), null), 0, 1));
    return ee.Dictionary({time: image.get('system:time_start'), validArea: weight,
      temperature: ee.Algorithms.If(weight.gt(0).and(hasTemperature),
        zeroIfNull(values, 'tw').divide(weight.max(1e-12)), null),
      precipitation: ee.Algorithms.If(weight.gt(0).and(hasPrecipitation),
        zeroIfNull(values, 'pw').divide(weight.max(1e-12)), null)});
  }
  function buildClimateSeries() {
    if (!S.aoiReady || !S.period || !S.collection || S.searchBusy) return;
    var job = S.climateJob;
    if (job) { renderClimateJob(job); nextClimateBatch(job); return; }
    var all = ee.ImageCollection(C.climate);
    // O catálogo possui dados históricos; não se usa first() em uma coleção filtrada vazia.
    var projection = ee.Image(all.first()).select('temperature_2m').projection();
    var collection = all.filterDate(S.period.start, S.period.endExclusive).sort('system:time_start');
    var region = S.aoi;
    var rawGrid = ee.Geometry(region).coveringGrid(projection);
    job = {version: S.searchVersion, collection: collection, projection: projection,
      grid: null, areaM2: S.areaM2, rows: [], offset: 0,
      total: 0, busy: true, complete: false, headerReady: false, error: null};
    S.climateJob = job;
    enqueue(function () { return ee.Dictionary({count: collection.size(),
      first: collection.aggregate_min('system:time_start'), last: collection.aggregate_max('system:time_start'),
      latest: all.aggregate_max('system:time_start'), gridCells: rawGrid.limit(C.maxClimateCells + 1).size(),
      scale: projection.nominalScale()}); },
      function () { return job.version === S.searchVersion && S.climateJob === job; },
      function (metadata, error) {
        job.busy = false;
        if (error || !metadata) job.error = error || 'Falha nos metadados ERA5-Land';
        else {
          job.headerReady = true; job.metadata = metadata; job.total = metadata.count || 0;
          job.complete = !job.total;
          if (metadata.gridCells > C.maxClimateCells) job.error =
            'O talhão excede o limite de ' + C.maxClimateCells + ' células climáticas. Reduza a área.';
          else if (job.total) job.grid = climateSamplingGrid(region, projection, rawGrid);
        }
        renderClimateJob(job); nextClimateBatch(job);
      });
  }
  function nextClimateBatch(job) {
    if (!job.headerReady || job.busy || job.complete || job.error || !S.chartsOpen) return;
    job.busy = true;
    var amount = Math.min(C.climateBatch, job.total - job.offset), offset = job.offset;
    enqueue(function () {
      return job.collection.toList(amount, offset).map(function (image) { return summarizeClimate(image, job); });
    }, function () { return job.version === S.searchVersion && S.climateJob === job; },
      function (rows, error) {
        job.busy = false;
        if (!error && rows && rows.length === amount) {
          job.failures = 0; job.rows = job.rows.concat(rows); job.offset += rows.length;
          job.complete = job.offset >= job.total;
        } else if (!retryBatch(job, function () { nextClimateBatch(job); })) {
          job.error = error || 'Lote climático incompleto';
        }
        renderClimateJob(job); nextClimateBatch(job);
      });
  }
  function renderClimateJob(job) {
    if (!S.chartsOpen || job.version !== S.searchVersion) return;
    renderClimateVariable(job, 'temperature'); renderClimateVariable(job, 'precipitation');
  }
  function renderClimateVariable(job, key) {
    var target = S.ui.chartCards[key];
    target.host.clear();
    if (!job.headerReady) {
      target.status.setValue(job.error ? errorText(job.error) : 'Consultando disponibilidade ERA5-Land…');
      return;
    }
    var metadata = job.metadata;
    if (!job.total) {
      target.status.setValue('Sem ERA5-Land no intervalo. Último dia do catálogo: ' + utc(metadata.latest, false));
      return;
    }
    var availability = utc(metadata.first, false) + ' a ' + utc(metadata.last, false);
    target.status.setValue(progress(job, 'dias') + ' · dados ' + availability);
    var valid = job.rows.filter(function (item) { return finite(item[key]); });
    if (!valid.length) {
      target.host.add(label('Sem valores válidos de clima no talhão até o momento.', {color: C.muted}));
      return;
    }
    var title = key === 'temperature' ? 'Temperatura média diária (°C)' : 'Precipitação acumulada no dia (mm)';
    var rows = job.rows.map(function (item) {
      var value = finite(item[key]) ? item[key] : null;
      return {c: [{v: chartDate(item.time)}, {v: value}, {v: utc(item.time, false) + ' UTC\n' + title + ': ' +
        number(value, 3) + '\nÁrea climática válida: ' + number(item.validArea / job.areaM2 * 100, 2) + '%'}]};
    });
    // Insere somente lacunas nulas entre dias indisponíveis, nunca valores preenchidos.
    var withGaps = [];
    rows.forEach(function (rowValue, i) {
      if (i > 0 && job.rows[i].time - job.rows[i - 1].time > 86400000) {
        withGaps.push({c: [{v: chartDate(job.rows[i - 1].time + 86400000)}, {v: null}, {v: 'Dia sem dados'}]});
      }
      withGaps.push(rowValue);
    });
    var table = {cols: [{label: 'Data (UTC)', type: 'date'}, {label: title, type: 'number'},
      {type: 'string', role: 'tooltip'}], rows: withGaps};
    var options = chartOptions(key === 'temperature' ? '°C' : 'mm / dia', key === 'temperature' ? '#d97706' : C.blue);
    var chart = ui.Chart(table).setChartType(key === 'temperature' ? 'LineChart' : 'ColumnChart').setOptions(options);
    chart.style().set({stretch: 'both', height: '179px', margin: '0'});
    target.host.add(chart);
    var note = 'Grade nativa ~' + number(metadata.scale / 1000, 1) + ' km · pesos por área intersectada';
    var requestedDays = Math.round((S.period.endTime - S.period.startTime) / 86400000) + 1;
    if (job.complete && job.total < requestedDays) note += ' · dias sem dados no período';
    if (key === 'precipitation' && valid.some(function (item) { return item.precipitation < 0; }))
      note += ' · valores negativos da fonte preservados';
    target.host.add(label(note, {fontSize: '9px', color: C.muted}));
  }

  // 9. CABEÇALHO, INFORMAÇÕES E INICIALIZAÇÃO -------------------------------
  function localTodayISO() {
    var today = new Date();
    return today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
  }
  function applyLastDays(days, search) {
    var end = localTodayISO(), time = Date.parse(end + 'T00:00:00Z');
    S.ui.start.setValue(new Date(time - (days - 1) * 86400000).toISOString().slice(0, 10), false);
    S.ui.end.setValue(end, false);
    if (search && S.aoiReady) searchSentinelImages();
  }
  function createHeader() {
    var u = S.ui;
    var datesChanged = ui.util.debounce(function () { if (S.aoiReady) searchSentinelImages(); }, 600);
    function onPeriodChange() {
      if (!S.aoiReady) return;
      var period = readPeriod();
      invalidateData(period ? 'Datas alteradas; aguardando pesquisa…' : 'Datas inválidas. Informe um intervalo válido.');
      S.period = null;
      u.period.setValue('Aguardando intervalo pesquisado');
      if (period) datesChanged();
    }
    u.start = ui.Textbox({placeholder: 'AAAA-MM-DD', onChange: onPeriodChange,
      style: {width: '93px', margin: '2px', fontSize: '11px'}});
    u.end = ui.Textbox({placeholder: 'AAAA-MM-DD', onChange: onPeriodChange,
      style: {width: '93px', margin: '2px', fontSize: '11px'}});
    u.search = button('Pesquisar', searchSentinelImages, true);
    var presetDays = [30, 90, 180, 365];
    if (presetDays.indexOf(C.defaultDays) < 0) presetDays.push(C.defaultDays);
    presetDays.sort(function (a, b) { return a - b; });
    var preset = ui.Select({items: presetDays.map(function (days) {
      return {label: days + ' dias', value: String(days)};
    }), value: String(C.defaultDays),
      onChange: function (value) { applyLastDays(Number(value), true); },
      style: {width: '89px', fontSize: '10px', margin: '2px'}});
    u.smoothing = ui.Select({items: Object.keys(SMOOTHING).map(function (key) {
      return {label: SMOOTHING[key].label, value: key};
    }), value: S.smoothing, onChange: setSmoothing, style: {width: '110px', fontSize: '10px', margin: '2px'}});
    var search = row([label('Sentinel-2', {fontWeight: 'bold', margin: '8px 5px 0 0'}),
      u.start, label('a', {margin: '8px 2px 0'}), u.end, preset, u.search,
      label('Suavização visual', {margin: '8px 2px 0 12px', color: C.muted}), u.smoothing],
      {margin: '0', padding: '0'});
    var info = button('⚙ Informações', function () {
      u.info.style().set('shown', !u.info.style().get('shown'));
    });
    // Layout com quebra de linha: em telas estreitas os controles descem.
    u.header = ui.Panel({widgets: [label('Monitoramento Agrícola | Google Earth Engine',
      {fontSize: '15px', fontWeight: 'bold', margin: '8px 14px 0 0'}), search, info],
      layout: ui.Panel.Layout.flow('horizontal', true),
      style: {stretch: 'horizontal', backgroundColor: '#ffffff', padding: '8px 12px', margin: '0',
        border: '1px solid ' + C.line}});
    u.area = label('Nenhum talhão selecionado', {fontWeight: 'bold', margin: '4px 9px', width: '310px'});
    u.status = label('Clique em “Selecionar talhão importado” para escolher um talhão.',
      {stretch: 'horizontal', margin: '4px 8px', color: C.muted});
    u.busy = label('✓ pronto', {margin: '4px 8px', color: C.muted, fontSize: '10px'});
    u.kmeansButton = button('Ativar K-means', toggleKMeans, false, {margin: '3px 1px'});
    u.statusRow = row([u.area, u.status, u.busy, u.kmeansButton,
      button('Selecionar talhão importado', function () { openImportPanel(false); }, true, {margin: '3px 1px'})],
      {stretch: 'horizontal', backgroundColor: '#f8fafc', margin: '0', padding: '0 8px'});
    u.info = ui.Panel({widgets: [
      row([label('Dados, escalas e uso', {fontWeight: 'bold', stretch: 'horizontal'}),
        button('Fechar', function () { u.info.style().set('shown', false); })]),
      label('Datas da pesquisa são inclusivas. Aquisições e gráficos usam UTC. As cenas são paginadas por data; nenhuma é excluída por nuvens.'),
      label('Talhões: escolhidos entre os imports registrados em TALHOES_IMPORTADOS (início do script): Geometry, Feature ou FeatureCollection com Polygon/MultiPolygon. A geometria original é usada sem simplificação; um talhão inválido é recusado e o atual é mantido.'),
      label('NDVI, NDWI, EVI e SAVI: 10 m. NDMI: B8 agregada por média à grade nativa B11 de 20 m. Sem aumento artificial de resolução.'),
      label('Suavização visual: Suave = interpolação bilinear; Intensificada = bicúbica (ee.Image.resample), apenas nas camadas RGB e de índice exibidas. Não cria detalhe nem aumenta a resolução (10 m; NDMI 20 m). Estatísticas, classes, séries e escalas de cor usam sempre os pixels nativos; as classes NDVI nunca são interpoladas.'),
      label('Cores dos índices: percentis 2–98 dos pixels da cena dentro do talhão (valores além saturam nas cores das pontas); mínimo e máximo reais aparecem na legenda.'),
      label('Os cinco percentuais usam apenas pixels NDVI válidos da mesma cena; NDVI fora de [−1; 1] (refletância negativa) fica fora da média, das classes e da série. A área do talhão no cabeçalho é vetorial; a cobertura usa a área rasterizada na grade da cena.'),
      label('NDVI indica vigor vegetativo; não estima kg/ha ou toneladas. Nuvens e sombras permanecem nos cálculos. Nuvens (%) refere-se à cena, não ao talhão.'),
      label('ERA5-Land é reanálise, não estação meteorológica. Média espacial ponderada pela interseção das células nativas (~11 km), inclusive para talhões pequenos.'),
      label('Temperatura: média do dia a 2 m, em °C. Chuva: total acumulado de cada dia, em mm, depois média espacial; não há média temporal da precipitação.'),
      label('A fonte ERA5 pode conter pequenos valores de chuva negativos por empacotamento GRIB; são preservados e sinalizados, sem correções silenciosas.'),
      label('Limites: ' + C.maxPixels + ' pixels por redução; ' + C.maxClimateCells + ' células climáticas; até ' +
        C.simultaneousRequests + ' requisições simultâneas (uma reservada à interface); ' + C.maxImportFeatures +
        ' feições listadas por coleção. Escalas não são reduzidas automaticamente.'),
      label('Cortina/alça e controles de navegação são nativos. Próximo às bordas da cortina, cartões podem ser recortados. Recolha os cartões com − para ampliar o mapa.'),
      label('Ao abrir os gráficos, os controles de imagem se recolhem para liberar espaço. Use + para abri-los; ao fechar os gráficos, o estado anterior é restaurado.'),
      label('Créditos: União Europeia/ESA/Copernicus Sentinel; ECMWF/Copernicus Climate Change Service (C3S), ERA5-Land; agregados Google/Copernicus CDS.'),
      ui.Label('Catálogo Sentinel-2 SR Harmonized', {fontSize: '10px'},
        'https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED'),
      ui.Label('Catálogo ERA5-Land e condições de uso', {fontSize: '10px'},
        'https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR')
    ], style: {shown: false, stretch: 'horizontal', height: '300px', padding: '8px 12px', margin: '0',
      backgroundColor: '#ffffff', border: '1px solid ' + C.line}});
    applyLastDays(C.defaultDays, false);
  }
  function createInterface() {
    // Limpa a raiz ANTES de construir os mapas e seus controles internos.
    ui.root.clear(); ui.root.setLayout(ui.Panel.Layout.flow('vertical'));
    createDrawingMap();
    createComparisonMaps();
    eachSide(function (side) { createImageSelectors(side); createVegetationPanels(side); });
    createToolbar(); createChartPanel(); createHeader(); configureDrawingTools();
    S.ui.mainPanel = ui.Panel({
      widgets: [S.ui.header, S.ui.statusRow, S.ui.info, S.ui.chartPanel, S.ui.stage],
      layout: ui.Panel.Layout.flow('vertical'),
      style: {stretch: 'both', backgroundColor: C.background, padding: '0', margin: '0'}
    });
    ui.root.widgets().reset([S.ui.mainPanel]);
  }
  function initializeApp() {
    createInterface();
    invalidateData('Clique em “Selecionar talhão importado” para escolher um talhão.');
    // Abre a lista de imports; se a primeira fonte tiver um único talhão
    // (por exemplo, a geometria "geometry"), ele é selecionado automaticamente.
    openImportPanel(true);
  }
  initializeApp();
}());
