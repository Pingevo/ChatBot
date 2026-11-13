const WEATHER_LOCATION = "Lat Luang, Samut Prakan";
const WEATHER_HEADERS = { "Cache-Control": "public, max-age=900, s-maxage=900, stale-while-revalidate=3600" };

type LocationResult = { latitude: number; longitude: number };
type WeatherResult = { current?: { weather_code?: number; is_day?: number; cloud_cover?: number } };

function weatherEventFor(code: number, isDay: number): number | null {
  if ([95, 96, 99].includes(code)) return 6;
  if ([51, 53, 55, 56, 57].includes(code)) return 13;
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return isDay === 0 ? 2 : 3;
  return null;
}

export async function GET() {
  try {
    const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocodeUrl.searchParams.set("name", WEATHER_LOCATION);
    geocodeUrl.searchParams.set("countryCode", "TH");
    geocodeUrl.searchParams.set("count", "1");
    geocodeUrl.searchParams.set("language", "en");

    const geocodeResponse = await fetch(geocodeUrl, { next: { revalidate: 86_400 } });
    if (!geocodeResponse.ok) return Response.json({ weatherEvent: null, cloudCover: null }, { headers: WEATHER_HEADERS });
    const geocode = await geocodeResponse.json() as { results?: LocationResult[] };
    const location = geocode.results?.[0];
    if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
      return Response.json({ weatherEvent: null, cloudCover: null }, { headers: WEATHER_HEADERS });
    }

    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.searchParams.set("latitude", String(location.latitude));
    forecastUrl.searchParams.set("longitude", String(location.longitude));
    forecastUrl.searchParams.set("current", "weather_code,is_day,cloud_cover");
    forecastUrl.searchParams.set("timezone", "Asia/Bangkok");
    const forecastResponse = await fetch(forecastUrl, { next: { revalidate: 900 } });
    if (!forecastResponse.ok) return Response.json({ weatherEvent: null, cloudCover: null }, { headers: WEATHER_HEADERS });
    const forecast = await forecastResponse.json() as WeatherResult;
    const code = forecast.current?.weather_code;
    const isDay = forecast.current?.is_day;
    const weatherEvent = typeof code === "number" && Number.isInteger(code)
      ? weatherEventFor(code, isDay === 0 ? 0 : 1)
      : null;
    const cloudCover = forecast.current?.cloud_cover;

    return Response.json({
      weatherEvent,
      cloudCover: typeof cloudCover === "number" && Number.isFinite(cloudCover)
        ? Math.max(0, Math.min(1, cloudCover / 100))
        : null,
    }, { headers: WEATHER_HEADERS });
  } catch {
    return Response.json({ weatherEvent: null, cloudCover: null }, { headers: WEATHER_HEADERS });
  }
}
