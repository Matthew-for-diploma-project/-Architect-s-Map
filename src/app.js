import { GENPLAN_BOUNDS } from './genplan-calibration.js';
import { initAccountDialog } from './account-dialog.js';

initAccountDialog();

const $ = id => document.getElementById(id);
const sidebar = $('sidebar');
const details = document.querySelector('.details');
const workspace = $('workspace');

sidebar.innerHTML = `<div class="eyebrow">Рабочая область</div><h2>Слои карты</h2>
  <section class="layer"><strong>Картографические подложки</strong><p>Включайте нужные подложки и задавайте прозрачность каждого слоя.</p><div id="baseLayers"></div>
    <div class="parcel-box">
      <label class="parcel-title"><input id="parcelToggle" type="checkbox" checked> <span><b>Земельные участки</b><small>НСПД № 36048 + резервная кадастровая карта</small></span></label>
      <label class="base-row"><span>Прозрачность участков</span><input id="parcelOpacity" aria-label="Прозрачность земельных участков" type="range" min="0" max="1" step=".05" value=".9"></label>
      <p id="parcelStatus" class="parcel-status" role="status">Загрузка границ участков…</p>
    </div>
    <div class="genplan-box"><b>Генеральный план Рязани</b><small>Оригинальный растр 2048×1928 px · геопривязка по ВПП Дягилево и Кремлю, проверена по городским ориентирам и руслу Оки.</small>
      <label class="base-row"><span>Прозрачность генплана</span><input id="genplanOpacity" aria-label="Прозрачность генплана" type="range" min="0" max="1" step=".05" value=".62"></label>
      <button id="genplanToggle" type="button" role="switch" aria-checked="true" class="cad-switch">Скрыть генплан</button><p id="genplanStatus" role="status">Генплан загружается…</p>
    </div>
  </section>
  <section class="layer"><strong>Мои карты и рисунки</strong><p>Добавьте PNG, JPEG или WebP. Перемещайте слой за маркер, растягивайте за угловые маркеры, меняйте поворот и прозрачность, затем зафиксируйте слой.</p>
    <input id="imageFile" type="file" accept="image/png,image/jpeg,image/webp" multiple><div id="drawingList"></div><p id="drawingMessage" role="status"></p>
  </section>`;

details.innerHTML = '<div id="inspector"><div class="eyebrow">Рабочая карта</div><h2>Карта Рязани</h2><p>Границы участков ЕГРН включены. Приблизьте карту и нажмите на участок — здесь появятся его кадастровые сведения.</p><div class="alert">Поиск сверху принимает адрес или кадастровый номер, например <b>62:29:0040006:531</b>.</div></div>';

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([54.6296, 39.7420], 15);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
map.createPane('genplan');
map.getPane('genplan').style.zIndex = 250;
map.createPane('parcelArchive');
map.getPane('parcelArchive').style.zIndex = 425;
map.createPane('parcels');
map.getPane('parcels').style.zIndex = 430;
map.createPane('parcelHighlight');
map.getPane('parcelHighlight').style.zIndex = 440;
map.createPane('drawings');
map.getPane('drawings').style.zIndex = 500;

const bases = {
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 19, opacity: .65 }),
  terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap, SRTM | OpenTopoMap', maxZoom: 17, opacity: .75 })
};
bases.osm.addTo(map);

for (const [id, label, initialOpacity] of [['osm', 'Обычная карта', 1], ['satellite', 'Спутник', .65], ['terrain', 'Рельеф', .75]]) {
  const row = document.createElement('div');
  row.className = 'base-row';
  row.innerHTML = `<label><input type="checkbox" ${id === 'osm' ? 'checked' : ''}> ${label}</label><input aria-label="Прозрачность ${label}" type="range" min="0" max="1" step=".05" value="${initialOpacity}">`;
  const checkbox = row.querySelector('input[type=checkbox]');
  const opacity = row.querySelector('input[type=range]');
  checkbox.addEventListener('change', () => checkbox.checked ? bases[id].addTo(map) : map.removeLayer(bases[id]));
  opacity.addEventListener('input', () => bases[id].setOpacity(Number(opacity.value)));
  $('baseLayers').append(row);
}

const CADASTRE_ARCHIVE = 'https://cogisdemo.dataeast.com/elitegis/rest/services/samples_cadastre_russia/cadastre_rf/MapServer';
const parcels = L.layerGroup().addTo(map);
const parcelStatus = $('parcelStatus');
let parcelHighlight = null;
let archiveOverlay = null;
let pendingArchiveOverlay = null;
let archiveGeneration = 0;
let archiveTimer = null;

function setParcelStatus(message, state = '') {
  parcelStatus.className = `parcel-status ${state}`.trim();
  parcelStatus.textContent = message;
}

function refreshArchiveParcels() {
  clearTimeout(archiveTimer);
  if (!map.hasLayer(parcels)) return;
  if (map.getZoom() < 14) {
    parcels.clearLayers();
    archiveOverlay = null;
    pendingArchiveOverlay = null;
    setParcelStatus('Слой включён. Приблизьте карту до уровня 14–15.', 'loading');
    return;
  }
  const generation = ++archiveGeneration;
  const bounds = map.getBounds();
  const southWest = map.options.crs.project(bounds.getSouthWest());
  const northEast = map.options.crs.project(bounds.getNorthEast());
  const size = map.getSize();
  const width = Math.min(2048, Math.max(256, Math.round(size.x)));
  const height = Math.min(2048, Math.max(256, Math.round(size.y)));
  const query = new URLSearchParams({
    bbox: [southWest.x, southWest.y, northEast.x, northEast.y].join(','),
    bboxSR: '3857', imageSR: '3857', size: `${width},${height}`,
    layers: 'show:32', format: 'png32', transparent: 'true', dpi: '96', f: 'image'
  });
  setParcelStatus('Загрузка реальных кадастровых границ…', 'loading');
  const candidate = L.imageOverlay(`${CADASTRE_ARCHIVE}/export?${query}`, bounds, {
    pane: 'parcelArchive', opacity: Number($('parcelOpacity').value), crossOrigin: 'anonymous', interactive: false,
    attribution: 'Кадастровая карта: CoGIS / DataEast'
  });
  pendingArchiveOverlay = candidate;
  candidate.once('load', () => {
    if (generation !== archiveGeneration || !map.hasLayer(parcels)) { parcels.removeLayer(candidate); return; }
    if (archiveOverlay && archiveOverlay !== candidate) parcels.removeLayer(archiveOverlay);
    archiveOverlay = candidate;
    pendingArchiveOverlay = null;
    setParcelStatus('Границы загружены · нажмите на участок. Дата сведений будет показана справа.', 'ready');
  });
  candidate.once('error', () => {
    if (parcels.hasLayer(candidate)) parcels.removeLayer(candidate);
    if (pendingArchiveOverlay === candidate) pendingArchiveOverlay = null;
    if (generation === archiveGeneration && !archiveOverlay) setParcelStatus('Кадастровая карта временно недоступна. Повторите позже.', 'error');
  });
  candidate.addTo(parcels);
}

function scheduleArchiveRefresh() {
  clearTimeout(archiveTimer);
  archiveTimer = setTimeout(refreshArchiveParcels, 280);
}

$('parcelToggle').addEventListener('change', e => {
  if (e.target.checked) {
    parcels.addTo(map);
    refreshArchiveParcels();
  } else {
    map.removeLayer(parcels);
    archiveGeneration += 1;
    setParcelStatus('Слой участков выключен.');
    if (parcelHighlight) { map.removeLayer(parcelHighlight); parcelHighlight = null; }
  }
});
$('parcelOpacity').addEventListener('input', e => {
  const opacity = Number(e.target.value);
  archiveOverlay?.setOpacity(opacity);
  pendingArchiveOverlay?.setOpacity(opacity);
});
map.on('moveend zoomend resize', scheduleArchiveRefresh);
setTimeout(refreshArchiveParcels, 0);

const genplan = L.imageOverlay('/genplan.jpg', GENPLAN_BOUNDS, { opacity: .62, pane: 'genplan', interactive: false }).addTo(map);
genplan.once('load', () => { $('genplanStatus').textContent = 'Генплан совмещён с картой по вычисленной геопривязке.'; });
genplan.once('error', () => { $('genplanStatus').textContent = 'Не удалось загрузить изображение генплана.'; });
$('genplanOpacity').addEventListener('input', e => genplan.setOpacity(Number(e.target.value)));
let genplanVisible = true;
$('genplanToggle').addEventListener('click', () => {
  genplanVisible = !genplanVisible;
  if (genplanVisible) genplan.addTo(map); else map.removeLayer(genplan);
  $('genplanToggle').textContent = genplanVisible ? 'Скрыть генплан' : 'Показать генплан';
  $('genplanToggle').setAttribute('aria-checked', String(genplanVisible));
});

const cadastralNumberPattern = /^\d{1,2}:\d{1,2}:\d{1,9}:\d{1,12}$/;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const normalizedKey = value => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
const archiveFields = ['cadastral_number', 'kvartal_cadastral_number', 'area', 'state', 'category', 'cadastral_cost', 'cadastral_cost_per_sqmeter', 'address_note', 'address_city', 'address_in_city', 'rights_state', 'rights_summary', 'rights_owner_type', 'extract_date', 'date_created', 'land_use_by_document', 'land_use_text', 'utilization_kind_group'].join(',');
const archiveDomains = {
  state: { '01': 'Ранее учтённый', '05': 'Временный', '06': 'Учтённый', '07': 'Снят с учёта', '08': 'Аннулированный' },
  category: { '003001000000': 'Земли сельскохозяйственного назначения', '003002000000': 'Земли населённых пунктов', '003003000000': 'Земли промышленности, энергетики, транспорта и иного специального назначения', '003004000000': 'Земли особо охраняемых территорий и объектов', '003005000000': 'Земли лесного фонда', '003006000000': 'Земли водного фонда', '003007000000': 'Земли запаса', '003008000000': 'Категория не установлена' },
  rights_state: { '0': 'Данные не загружены', '1': 'Права зарегистрированы', '-1': 'Права отсутствуют' },
  rights_owner_type: { '007001000000': 'Публично-правовое образование', '007002000000': 'Юридическое лицо', '007003000000': 'Физическое лицо' },
  utilization_kind_group: { '141000000000': 'Сельскохозяйственное использование', '142000000000': 'Объекты населённых пунктов', '143000000000': 'Промышленность, энергетика, транспорт и специальное назначение', '144000000000': 'Особо охраняемые историко-культурные и природные объекты', '145000000000': 'Лесной фонд', '146000000000': 'Водный фонд', '147000000000': 'Земли запаса' }
};
const archiveDomainValue = (field, value) => archiveDomains[field]?.[String(value)] || value || '';
const formattedNumber = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value)) : (value || '');
const formattedDate = value => Number.isFinite(Number(value)) && Number(value) > 0 ? new Intl.DateTimeFormat('ru-RU').format(new Date(Number(value))) : '';

function signedRingArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  return sum / 2;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function archiveGeometry(geometry) {
  if (Array.isArray(geometry?.rings) && geometry.rings.length) {
    const outerRings = geometry.rings.filter(ring => signedRingArea(ring) < 0);
    const holeRings = geometry.rings.filter(ring => signedRingArea(ring) >= 0);
    if (!outerRings.length) return { type: 'Polygon', coordinates: geometry.rings };
    const polygons = outerRings.map(ring => [ring]);
    for (const hole of holeRings) {
      const owner = outerRings.findIndex(outer => pointInRing(hole[0], outer));
      polygons[Math.max(0, owner)].push(hole);
    }
    return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
  }
  if (Number.isFinite(geometry?.x) && Number.isFinite(geometry?.y)) return { type: 'Point', coordinates: [geometry.x, geometry.y] };
  return null;
}

function archiveFeature(item) {
  const a = item.attributes || {};
  const dataDate = formattedDate(a.extract_date);
  const use = a.land_use_by_document || a.land_use_text || archiveDomainValue('utilization_kind_group', a.utilization_kind_group);
  return {
    type: 'Feature',
    geometry: archiveGeometry(item.geometry),
    properties: {
      'Кадастровый номер': a.cadastral_number,
      'Адрес': a.address_note || [a.address_city, a.address_in_city].filter(Boolean).join(', '),
      'Площадь, м²': formattedNumber(a.area),
      'Статус': archiveDomainValue('state', a.state),
      'Категория земель': archiveDomainValue('category', a.category),
      'Разрешённое использование': use,
      'Кадастровая стоимость, ₽': formattedNumber(a.cadastral_cost),
      'Стоимость за м², ₽': formattedNumber(a.cadastral_cost_per_sqmeter),
      'Кадастровый квартал': a.kvartal_cadastral_number,
      'Дата постановки на учёт': formattedDate(a.date_created),
      'Дата выгрузки из ЕГРН': dataDate,
      'Наличие сведений о правах': archiveDomainValue('rights_state', a.rights_state),
      'Тип собственника': archiveDomainValue('rights_owner_type', a.rights_owner_type),
      'Права и обременения': a.rights_summary,
      _archive: true,
      _dataDate: dataDate,
      _area: Number(a.area) || Number.POSITIVE_INFINITY
    }
  };
}

async function archiveQuery(parameters, signal) {
  const query = new URLSearchParams({
    where: '1=1', outFields: archiveFields, returnGeometry: 'true', outSR: '4326', f: 'json', resultRecordCount: '10', ...parameters
  });
  const response = await fetch(`${CADASTRE_ARCHIVE}/32/query?${query}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Резервная кадастровая карта ответила HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Ошибка резервной кадастровой карты');
  return (data.features || []).map(archiveFeature).filter(feature => feature.geometry);
}

async function archiveParcelAt(latlng, signal) {
  const features = await archiveQuery({
    geometry: `${latlng.lng},${latlng.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects'
  }, signal);
  const feature = features.sort((a, b) => a.properties._area - b.properties._area)[0];
  if (!feature) throw new Error('В выбранной точке участок не найден в резервной карте');
  return { feature, source: 'открытая кадастровая карта' };
}

async function archiveParcelByNumber(cadastralNumber, signal) {
  const features = await archiveQuery({ where: `cadastral_number='${cadastralNumber}'`, resultRecordCount: '5' }, signal);
  const feature = features[0];
  if (!feature) throw new Error('Участок не найден в резервной карте');
  return { feature, source: 'открытая кадастровая карта' };
}

function flattenProperties(value, path = [], output = []) {
  if (output.length >= 80 || value === null || value === undefined || value === '') return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const label = item.name ?? item.title ?? item.label;
        const itemValue = item.value ?? item.values ?? item.text ?? item.description;
        if (label !== undefined && itemValue !== undefined) flattenProperties(itemValue, [...path, String(label)], output);
        else flattenProperties(item, [...path, String(index + 1)], output);
      } else flattenProperties(item, path, output);
    });
    return output;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, nested]) => {
      if (!key.startsWith('_') && !['geometry', 'coordinates'].includes(key)) flattenProperties(nested, [...path, key], output);
    });
    return output;
  }
  const text = String(value).trim();
  if (text) output.push({ key: path.join(' · ') || 'Значение', value: text });
  return output;
}

function propertyEntries(feature) {
  const entries = flattenProperties(feature?.properties || {});
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    const signature = `${normalizedKey(entry.key)}|${entry.value}`;
    if (!seen.has(signature)) { seen.add(signature); unique.push(entry); }
  }
  return unique;
}

function entryValue(entries, patterns) {
  for (const pattern of patterns) {
    const found = entries.find(entry => pattern.test(normalizedKey(entry.key)));
    if (found) return found.value;
  }
  return '';
}

function parcelFields(feature) {
  const entries = propertyEntries(feature);
  return {
    entries,
    cad: entryValue(entries, [/^descr$/, /кадастров.*номер/, /cad.*num/, /^cn$/]) || '',
    address: entryValue(entries, [/адрес/, /address/]) || '',
    area: entryValue(entries, [/площад/, /^area$/, /area value/]) || '',
    category: entryValue(entries, [/категор.*зем/, /land category/, /^category$/]) || '',
    use: entryValue(entries, [/разреш.*использ/, /вид использования/, /permitted use/, /utilization/]) || '',
    status: entryValue(entries, [/статус/, /^status$/]) || '',
    cost: entryValue(entries, [/кадастр.*стоим/, /cad.*cost/, /cadastral value/]) || '',
    dataDate: entryValue(entries, [/дата выгрузки/, /extract date/]) || ''
  };
}

function openDetailsPanel() {
  workspace.classList.remove('details-collapsed');
  const button = $('toggleDetails');
  if (button) {
    button.setAttribute('aria-expanded', 'true');
    button.title = 'Свернуть правую панель';
  }
  setTimeout(() => map.invalidateSize(), 160);
}

function showDetailsMessage(title, message, kind = 'alert') {
  openDetailsPanel();
  details.innerHTML = `<div id="inspector"><div class="eyebrow">Кадастровая карта · участки</div><h2>${escapeHtml(title)}</h2><div class="${kind}">${escapeHtml(message)}</div></div>`;
}

function drawParcelHighlight(feature, fit = false) {
  if (parcelHighlight) map.removeLayer(parcelHighlight);
  parcelHighlight = null;
  if (!feature?.geometry) return;
  try {
    parcelHighlight = L.geoJSON(feature, {
      pane: 'parcelHighlight',
      interactive: false,
      style: { color: '#ff2d55', weight: 4, opacity: 1, fillColor: '#ffd0da', fillOpacity: .2 },
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { pane: 'parcelHighlight', radius: 9, color: '#ff2d55', weight: 4, fillColor: '#ffd0da', fillOpacity: .35 })
    }).addTo(map);
    if (fit && parcelHighlight.getBounds?.().isValid()) map.fitBounds(parcelHighlight.getBounds(), { padding: [55, 55], maxZoom: 18 });
  } catch (error) {
    console.warn('parcel_highlight', error);
  }
}

function renderParcel(feature, { fit = false, source = 'выбрано на карте' } = {}) {
  const fields = parcelFields(feature);
  const archived = Boolean(feature.properties?._archive);
  const visibleRows = [
    ['Площадь', fields.area],
    ['Категория земель', fields.category],
    ['Разрешённое использование', fields.use],
    ['Статус', fields.status],
    ['Кадастровая стоимость', fields.cost],
    ['Дата данных', fields.dataDate]
  ];
  const rows = visibleRows.map(([label, value]) => `<tr><th>${label}</th><td class="${value ? '' : 'missing'}">${escapeHtml(value || 'Нет данных в публичном ответе')}</td></tr>`).join('');
  const allRows = fields.entries.slice(0, 36).map(entry => `<tr><th>${escapeHtml(entry.key)}</th><td>${escapeHtml(entry.value)}</td></tr>`).join('');
  openDetailsPanel();
  details.innerHTML = `<div id="inspector">
    <div class="eyebrow">Земельный участок · ${escapeHtml(source)}</div>
    <h2 class="cad">${escapeHtml(fields.cad || 'Кадастровый номер не передан')}</h2>
    <p class="address">${escapeHtml(fields.address || 'Адрес отсутствует в публичном ответе НСПД')}</p>
    <table class="facts"><tbody>${rows}</tbody></table>
    <div class="alert">${archived ? `Показана открытая архивная копия кадастровых сведений${fields.dataDate ? ` от ${escapeHtml(fields.dataDate)}` : ''}. Проверьте изменения на НСПД.` : 'Сведения НСПД носят справочный характер и не заменяют официальную выписку ЕГРН.'}</div>
    ${allRows ? `<details><summary>Все доступные поля (${fields.entries.length})</summary><table class="facts compact"><tbody>${allRows}</tbody></table></details>` : ''}
    <a class="source-button" href="https://nspd.gov.ru/map?thematic=PKK" target="_blank" rel="noopener">Открыть публичную кадастровую карту НСПД ↗</a>
  </div>`;
  drawParcelHighlight(feature, fit);
}

let identifyController = null;
function nspdIdentifyQuery(latlng) {
  const bounds = map.getBounds();
  const southWest = map.options.crs.project(bounds.getSouthWest());
  const northEast = map.options.crs.project(bounds.getNorthEast());
  const actual = map.getSize();
  const width = Math.min(2048, Math.max(1, Math.round(actual.x)));
  const height = Math.min(2048, Math.max(1, Math.round(actual.y)));
  const point = map.latLngToContainerPoint(latlng);
  const x = Math.max(0, Math.min(width - 1, Math.round(point.x * width / actual.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(point.y * height / actual.y)));
  return new URLSearchParams({
    BBOX: [southWest.x, southWest.y, northEast.x, northEast.y].join(','),
    WIDTH: String(width), HEIGHT: String(height), X: String(x), Y: String(y)
  });
}

async function nspdParcelAt(latlng, signal) {
  const response = await fetch(`/api/cadastre/identify?${nspdIdentifyQuery(latlng)}`, { signal, headers: { Accept: 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'НСПД временно недоступна');
  const feature = data.features?.find(item => item.geometry) || data.features?.[0];
  if (!feature) throw new Error('В выбранной точке участок не найден в НСПД');
  return { feature, source: 'НСПД' };
}

async function nspdParcelByNumber(cadastralNumber, signal) {
  const response = await fetch(`/api/cadastre/search?q=${encodeURIComponent(cadastralNumber)}`, { signal, headers: { Accept: 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Поиск НСПД временно недоступен');
  const exact = data.features?.find(feature => parcelFields(feature).cad === cadastralNumber);
  const feature = exact || data.features?.find(item => item.geometry) || data.features?.[0];
  if (!feature) throw new Error('Участок не найден в НСПД');
  return { feature, source: 'НСПД' };
}

function cadastralFailure(error, fallback) {
  const messages = error?.errors?.map(item => item?.message).filter(Boolean);
  return messages?.length ? [...new Set(messages)].join('. ') : (error?.message || fallback);
}

async function identifyParcel(event) {
  if (!map.hasLayer(parcels)) return;
  if (map.getZoom() < 13) {
    setParcelStatus('Приблизьте карту минимум до уровня 13, затем нажмите на участок.', 'loading');
    return;
  }
  identifyController?.abort();
  identifyController = new AbortController();
  const signal = identifyController.signal;
  showDetailsMessage('Получаю сведения…', 'Запрашиваю данные выбранного участка в кадастровых источниках.');
  try {
    const result = await Promise.any([archiveParcelAt(event.latlng, signal), nspdParcelAt(event.latlng, signal)]);
    identifyController.abort();
    setParcelStatus('Участок выбран · сведения показаны справа.', 'ready');
    renderParcel(result.feature, { source: result.source });
  } catch (error) {
    if (signal.aborted) return;
    const message = cadastralFailure(error, 'Сведения об участке не получены');
    setParcelStatus(message, 'error');
    showDetailsMessage('Сведения не получены', `${message}. Попробуйте нажать точнее внутри контура.`, 'alert error-box');
  }
}

async function searchParcel(cadastralNumber) {
  if (!map.hasLayer(parcels)) {
    parcels.addTo(map);
    $('parcelToggle').checked = true;
    refreshArchiveParcels();
  }
  setParcelStatus(`Поиск участка ${cadastralNumber}…`, 'loading');
  showDetailsMessage('Ищу участок…', `Кадастровый номер: ${cadastralNumber}`);
  const controller = new AbortController();
  try {
    const result = await Promise.any([archiveParcelByNumber(cadastralNumber, controller.signal), nspdParcelByNumber(cadastralNumber, controller.signal)]);
    controller.abort();
    setParcelStatus(`Найден участок ${cadastralNumber}.`, 'ready');
    renderParcel(result.feature, { fit: true, source: `${result.source} · поиск по номеру` });
  } catch (error) {
    controller.abort();
    throw new Error(cadastralFailure(error, 'Участок с таким кадастровым номером не найден'));
  }
}

map.on('click', identifyParcel);

const drawings = [];
const opposite = { northWest: 'southEast', northEast: 'southWest', southEast: 'northWest', southWest: 'northEast' };
const corners = ['northWest', 'northEast', 'southEast', 'southWest'];
const cornerPoint = { northWest: b => b.getNorthWest(), northEast: b => b.getNorthEast(), southEast: b => b.getSouthEast(), southWest: b => b.getSouthWest() };
const icon = cls => L.divIcon({ className: cls, html: '', iconSize: [16, 16], iconAnchor: [8, 8] });

function applyRotation(d) {
  const image = d.layer.getElement();
  if (!image) return;
  const withoutRotation = (image.style.transform || '').replace(/\s*rotate\([^)]*\)/g, '').trim();
  image.style.transformOrigin = '50% 50%';
  image.style.transform = `${withoutRotation}${d.angle ? ` rotate(${d.angle}deg)` : ''}`.trim();
}

function rebuildHandles(d) {
  d.handles.clearLayers();
  if (d.locked) return;
  const bounds = d.layer.getBounds();
  for (const corner of corners) {
    const marker = L.marker(cornerPoint[corner](bounds), { draggable: true, icon: icon('image-handle'), zIndexOffset: 1000 }).addTo(d.handles);
    marker.on('drag', () => {
      const fixed = cornerPoint[opposite[corner]](d.layer.getBounds());
      d.layer.setBounds(L.latLngBounds(marker.getLatLng(), fixed));
    });
    marker.on('dragend', () => rebuildHandles(d));
  }
  const move = L.marker(bounds.getCenter(), { draggable: true, icon: L.divIcon({ className: 'image-move', html: '✥', iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 1001 }).addTo(d.handles);
  let last = null;
  move.on('dragstart', () => { last = move.getLatLng(); });
  move.on('drag', () => {
    const now = move.getLatLng();
    const current = d.layer.getBounds();
    d.layer.setBounds([[current.getSouth() + now.lat - last.lat, current.getWest() + now.lng - last.lng], [current.getNorth() + now.lat - last.lat, current.getEast() + now.lng - last.lng]]);
    last = now;
  });
  move.on('dragend', () => rebuildHandles(d));
}

function addDrawing(file) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) return reject(new Error('Нужен PNG/JPEG/WebP до 20 МБ'));
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const center = map.latLngToLayerPoint(map.getCenter());
      const width = Math.min(map.getSize().x * .55, 600);
      const height = width * image.height / image.width;
      const bounds = L.latLngBounds(map.layerPointToLatLng(center.subtract([width / 2, height / 2])), map.layerPointToLatLng(center.add([width / 2, height / 2])));
      const d = { file, url, angle: 0, locked: false, layer: L.imageOverlay(url, bounds, { opacity: .65, pane: 'drawings', interactive: false }).addTo(map), handles: L.layerGroup().addTo(map) };
      drawings.push(d);
      applyRotation(d);
      rebuildHandles(d);
      resolve(d);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать изображение')); };
    image.src = url;
  });
}

function addDrawingRow(d) {
  const row = document.createElement('div');
  row.className = 'drawing-row';
  const safeName = d.file.name.replace(/[&<>"']/g, '');
  row.innerHTML = `<b title="${safeName}">${safeName}</b><label>Прозрачность <input class="drawing-opacity" aria-label="Прозрачность ${safeName}" type="range" min="0" max="1" step=".05" value=".65"></label><label>Поворот <output class="angle-value">0°</output><input class="drawing-angle" aria-label="Поворот ${safeName}" type="range" min="-180" max="180" step="1" value="0"></label><div class="drawing-actions"><button class="lock" type="button">Зафиксировать</button><button class="locate" type="button">Показать</button><button class="remove" type="button">Удалить</button></div>`;
  row.querySelector('.drawing-opacity').addEventListener('input', e => d.layer.setOpacity(Number(e.target.value)));
  row.querySelector('.drawing-angle').addEventListener('input', e => { d.angle = Number(e.target.value); row.querySelector('.angle-value').textContent = `${d.angle}°`; applyRotation(d); });
  row.querySelector('.lock').addEventListener('click', e => { d.locked = !d.locked; e.currentTarget.textContent = d.locked ? 'Разблокировать' : 'Зафиксировать'; rebuildHandles(d); });
  row.querySelector('.locate').addEventListener('click', () => map.fitBounds(d.layer.getBounds(), { padding: [40, 40] }));
  row.querySelector('.remove').addEventListener('click', () => { map.removeLayer(d.layer); map.removeLayer(d.handles); URL.revokeObjectURL(d.url); drawings.splice(drawings.indexOf(d), 1); row.remove(); });
  $('drawingList').append(row);
}

$('imageFile').addEventListener('change', async e => {
  for (const file of e.target.files) {
    try { const d = await addDrawing(file); addDrawingRow(d); $('drawingMessage').textContent = 'Слой добавлен: переместите, растяните или поверните его, затем зафиксируйте.'; }
    catch (error) { $('drawingMessage').textContent = error.message; }
  }
  e.target.value = '';
});

map.on('zoomend moveend resize', () => { for (const d of drawings) { applyRotation(d); if (!d.locked) rebuildHandles(d); } });
map.on('mousemove', e => { const coord = $('coord'); if (coord) coord.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; });
function setPanelState(panel, button) {
  const className = panel === 'sidebar' ? 'sidebar-collapsed' : 'details-collapsed';
  const collapsed = workspace.classList.toggle(className);
  const open = !collapsed;
  button.setAttribute('aria-expanded', String(open));
  button.title = `${open ? 'Свернуть' : 'Развернуть'} ${panel === 'sidebar' ? 'левую панель' : 'правую панель'}`;
  button.querySelector('span').textContent = open ? (panel === 'sidebar' ? 'Слои' : 'Сведения') : (panel === 'sidebar' ? 'Слои' : 'Сведения');
  setTimeout(() => map.invalidateSize(), 160);
}
const toggleSidebar = $('toggleSidebar');
const toggleDetails = $('toggleDetails');
if (toggleSidebar) toggleSidebar.addEventListener('click', () => setPanelState('sidebar', toggleSidebar));
if (toggleDetails) toggleDetails.addEventListener('click', () => setPanelState('details', toggleDetails));
const drawer = $('drawer');
if ($('aboutBtn') && drawer) $('aboutBtn').addEventListener('click', () => drawer.classList.add('open'));
if ($('closeDrawer') && drawer) $('closeDrawer').addEventListener('click', () => drawer.classList.remove('open'));
const searchForm = $('searchForm');
if (searchForm) searchForm.addEventListener('submit', async e => {
  e.preventDefault();
  const query = $('searchInput').value.trim();
  if (!query) return;
  const button = searchForm.querySelector('button');
  button.disabled = true;
  try {
    const cadastralQuery = query.replace(/\s+/g, '');
    if (cadastralNumberPattern.test(cadastralQuery)) {
      await searchParcel(cadastralQuery);
      return;
    }
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru&q=${encodeURIComponent(query)}`);
    const results = await response.json();
    if (!results.length) throw new Error('Адрес не найден');
    map.setView([Number(results[0].lat), Number(results[0].lon)], 16);
  } catch (error) {
    parcelStatus.className = 'parcel-status error';
    parcelStatus.textContent = error.message;
    showDetailsMessage('Поиск не выполнен', error.message, 'alert error-box');
  } finally { button.disabled = false; }
});
setTimeout(() => map.invalidateSize(), 0);
