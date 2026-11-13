# Login scene asset credits

The scene uses these photos under the Unsplash License:

- `torii-lake.jpg` — Wu Hsien Yu, [Unsplash](https://unsplash.com/photos/a-tori-tori-floating-in-the-middle-of-a-body-of-water-2gGPUM_z1XA)
- `japan-mountains.jpg` — Stefan Szankowski, [Mount Fuji above green forest](https://unsplash.com/photos/mount-fuji-above-green-forest-WfkxI4wLa3o)
- `moon-map.jpg` — NASA/GSFC Scientific Visualization Studio, LRO color mosaic from the [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)

The maple leaf model is CC0:

- `models/maple-leaf.glb` — a single leaf mesh extracted from [Innerscene's CC0 maple tree source](https://www.innerscene.com/tools/library/3d-parts/maple-street-tree-detailed-leaves-006cddf4). Three.js adds tumbling fall, gust, distance scale, and fade-out motion.

Sakura petals are procedural instanced meshes.

## Weather data

Current weather data is provided by [Open-Meteo](https://open-meteo.com/) and licensed under [CC BY 4.0](https://open-meteo.com/en/license). Rain effects follow current weather codes and cloud cover adjusts the sky. The login scene uses the low-frequency public endpoint for this private, non-commercial decorative use and falls back to device time and non-weather events when weather data is unavailable.
