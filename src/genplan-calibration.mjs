// Геопривязка исходного листа генплана 2048×1928 px.
//
// Лист ориентирован на север, поэтому достаточно независимого масштаба по
// осям и смещения. Опорные точки — концы ВПП Дягилево и центр территории
// Рязанского кремля: на растре они хорошо различимы, а координаты взяты из
// геометрии OSM. МНК уменьшает влияние толщины условных знаков. Расчёт по Web
// Mercator повторяет проекцию, в которой Leaflet растягивает imageOverlay.

export const GENPLAN_IMAGE_SIZE = Object.freeze({ width: 2048, height: 1928 });

export const GENPLAN_CONTROL_POINTS = Object.freeze([
  Object.freeze({
    label: 'ВПП Дягилево, западный торец',
    image: Object.freeze([392.48, 936.52]),
    lngLat: Object.freeze([39.547355, 54.638319])
  }),
  Object.freeze({
    label: 'ВПП Дягилево, восточный торец',
    image: Object.freeze([559.80, 876.55]),
    lngLat: Object.freeze([39.591597, 54.646555])
  }),
  Object.freeze({
    label: 'Рязанский кремль, центр территории',
    image: Object.freeze([1180.20, 950.40]),
    lngLat: Object.freeze([39.7496288, 54.6362500])
  })
]);

const EARTH_RADIUS = 6378137;
const toRadians = degrees => degrees * Math.PI / 180;
const toDegrees = radians => radians * 180 / Math.PI;
const mercatorY = latitude => EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + toRadians(latitude) / 2));
const latitudeFromMercatorY = y => toDegrees(2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2);

function linearFit(samples) {
  const count = samples.length;
  const meanX = samples.reduce((sum, [x]) => sum + x, 0) / count;
  const meanY = samples.reduce((sum, [, y]) => sum + y, 0) / count;
  const numerator = samples.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denominator = samples.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  const slope = numerator / denominator;
  return { slope, intercept: meanY - slope * meanX };
}

export function calibratedBounds(
  size = GENPLAN_IMAGE_SIZE,
  controlPoints = GENPLAN_CONTROL_POINTS
) {
  const longitudeFit = linearFit(controlPoints.map(point => [point.image[0], point.lngLat[0]]));
  const mercatorFit = linearFit(controlPoints.map(point => [point.image[1], mercatorY(point.lngLat[1])]));
  const west = longitudeFit.intercept;
  const east = longitudeFit.intercept + size.width * longitudeFit.slope;
  const northMercatorY = mercatorFit.intercept;
  const southMercatorY = mercatorFit.intercept + size.height * mercatorFit.slope;

  return Object.freeze([
    Object.freeze([latitudeFromMercatorY(southMercatorY), west]),
    Object.freeze([latitudeFromMercatorY(northMercatorY), east])
  ]);
}

export const GENPLAN_BOUNDS = calibratedBounds();
