"use client";

import { useEffect, useRef, useState } from "react";
import SceneWildlife from "./SceneWildlife";

const scenes = {
  torii: {
    src: "/login/torii-lake.jpg",
    credit: "Wu Hsien Yu",
    url: "https://unsplash.com/photos/a-tori-tori-floating-in-the-middle-of-a-body-of-water-2gGPUM_z1XA",
    horizon: 0.455,
  },
};

const weatherEvents = [
  { id: 2, duration: 86_400, weatherControlled: true },
  { id: 3, duration: 86_400, weatherControlled: true },
  { id: 6, duration: 86_400, weatherControlled: true },
  { id: 13, duration: 86_400, weatherControlled: true },
];
const randomEvents = [
  { id: 16, periods: ["dawn", "day", "evening"], weight: 0.38, duration: 300 },
  { id: 17, periods: ["dusk", "night"], weight: 0.31, duration: 300 },
  { id: 18, periods: ["day", "evening", "dusk"], weight: 0.34, duration: 300 },
  { id: 24, periods: ["night"], weight: 0.12, duration: 300 },
  { id: 27, periods: ["day", "evening", "dusk"], weight: 0.16, duration: 300 },
];

const eventCycles = { 16: 32, 17: 19, 18: 18, 24: 36, 27: 24 };

function periodAt(progress) {
  if (progress < 0.2083 || progress >= 0.8021) return "night";
  if (progress < 0.27) return "dawn";
  if (progress < 0.6979) return "day";
  if (progress < 0.7396) return "evening";
  return "dusk";
}

const vertexSource = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `
precision highp float;
uniform sampler2D u_photo;
uniform sampler2D u_moonMap;
uniform sampler2D u_japan;
uniform vec2 u_resolution;
uniform vec2 u_photoSize;
uniform vec2 u_japanSize;
uniform float u_time;
uniform float u_portalTime;
uniform float u_progress;
uniform float u_portalProgress;
uniform float u_portalLight;
uniform float u_horizon;
uniform float u_guardTorii;
uniform float u_windStrength;
uniform vec2 u_windDirection;
uniform float u_waveStrength;
uniform vec4 u_ripples[4];
uniform float u_reducedMotion;
uniform float u_japanBlend;
uniform float u_event;
uniform float u_eventStrength;
uniform float u_eventTime;
uniform float u_eventDuration;
uniform float u_eventCycleTime;
uniform float u_eventCycleDuration;
uniform float u_eventDirection;
uniform float u_eventVariant;
uniform float u_weatherCloudCover;
varying vec2 v_uv;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float weight = 0.5;
  for (int i = 0; i < 3; i++) {
    value += noise(p) * weight;
    p = mat2(1.62, 1.18, -1.18, 1.62) * p;
    weight *= 0.5;
  }
  return value / 0.875;
}

float waveHeight(vec2 p, float time, float wind, vec2 windDirection, out vec2 slope) {
  vec2 acrossWind = vec2(-windDirection.y, windDirection.x);
  vec2 crossDirection = normalize(windDirection * 0.55 + acrossWind * 0.84);
  vec2 fineDirection = normalize(windDirection * 0.55 - acrossWind * 0.84);
  vec2 diagonalDirection = normalize(windDirection * 0.90 + acrossWind * 0.44);
  float broadFlow = fbm(p * 0.22 + windDirection * time * 0.026 + crossDirection * time * 0.009);
  float surfaceFlow = fbm(p * 0.68 + crossDirection * time * 0.052 - windDirection * time * 0.019);
  float phaseWarp = (broadFlow - 0.5) * 2.4 + (surfaceFlow - 0.5) * 1.3;
  float longPhase = dot(p, windDirection) * 1.15 - time * 1.12 + phaseWarp;
  float longAmplitude = 0.052 * (0.62 + broadFlow * 0.76);
  float longSwell = sin(longPhase) * longAmplitude;
  float secondaryPhase = dot(p, crossDirection) * 2.35 - time * 1.73 + phaseWarp * 0.72 + surfaceFlow * 1.2;
  float secondaryAmplitude = 0.022 * (0.66 + surfaceFlow * 0.72);
  float secondarySwell = sin(secondaryPhase) * secondaryAmplitude;
  float diagonalPhase = dot(p, diagonalDirection) * 3.08 - time * 2.34 + phaseWarp * 0.52;
  float diagonalSwell = sin(diagonalPhase) * 0.0085;
  float windLinePhase = dot(p, fineDirection) * 5.8 - time * 2.79 + 2.4 + surfaceFlow * 1.5;
  float windLines = sin(windLinePhase) * 0.0048;
  float smallChopPhase = dot(p, fineDirection) * 11.5 - time * 3.87 + phaseWarp * 0.36;
  float smallChop = sin(smallChopPhase) * 0.0012;
  vec2 counterSwellDirection = normalize(windDirection * 0.15 - acrossWind * 0.99);
  float independentPhase = dot(p, counterSwellDirection) * 0.88 - time * 0.64 + broadFlow * 2.1;
  float independentAmplitude = 0.013 * (0.42 + broadFlow * 1.05);
  float independentSwell = sin(independentPhase) * independentAmplitude;
  float crossChopPhase = dot(p, crossDirection) * 4.15 - time * 2.18 + surfaceFlow * 2.6;
  float crossChop = sin(crossChopPhase) * 0.0036;
  vec2 baseSlope = windDirection * (1.15 * cos(longPhase) * longAmplitude)
    + crossDirection * (2.35 * cos(secondaryPhase) * secondaryAmplitude)
    + diagonalDirection * (3.08 * cos(diagonalPhase) * 0.0085)
    + fineDirection * (5.8 * cos(windLinePhase) * 0.0048 + 11.5 * cos(smallChopPhase) * 0.0012)
    + counterSwellDirection * (0.88 * cos(independentPhase) * independentAmplitude)
    + crossDirection * (4.15 * cos(crossChopPhase) * 0.0036);
  float pointerRipple = 0.0;
  vec2 pointerSlope = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 ripple = u_ripples[i];
    float rippleAge = time - ripple.z;
    if (ripple.w > 0.0 && rippleAge >= 0.0 && rippleAge < 4.6) {
      vec2 rippleDelta = p - ripple.xy;
      float rippleDistance = length(rippleDelta);
      float ringFront = rippleDistance - rippleAge * 0.82;
      float ringEnvelope = exp(-abs(ringFront) * 2.8) * exp(-rippleAge * 0.58);
      float perspectiveFade = 1.0 - smoothstep(10.0, 22.0, ripple.y) * 0.45;
      float ringWave = sin(ringFront * 12.0);
      pointerRipple += ringWave * ringEnvelope * ripple.w * 0.10 * perspectiveFade;
      float ringDerivative = (12.0 * cos(ringFront * 12.0) - 2.8 * sign(ringFront) * ringWave)
        * ringEnvelope * ripple.w * 0.10 * perspectiveFade;
      pointerSlope += rippleDelta / max(rippleDistance, 0.001) * ringDerivative;
    }
  }
  float rain = max(max(step(1.5, u_event) * (1.0 - step(2.5, u_event)), step(2.5, u_event) * (1.0 - step(3.5, u_event))),
    max(step(5.5, u_event) * (1.0 - step(6.5, u_event)), step(12.5, u_event) * (1.0 - step(13.5, u_event))));
  float rainChopPhase = dot(p, fineDirection) * 18.0 - time * 6.3;
  float rainChopAmplitude = 0.0018 * rain * u_eventStrength;
  float rainChop = sin(rainChopPhase) * rainChopAmplitude;
  float rainImpact = 0.0;
  vec2 dolphinImpactSlope = vec2(0.0);
  if (rain > 0.001) {
    vec2 cell = floor(p * 0.72);
    float seed = hash21(cell);
    vec2 center = (cell + vec2(hash21(cell + vec2(4.7)), hash21(cell + vec2(13.2)))) / 0.72;
    float dropAge = fract(u_eventTime * (0.34 + seed * 0.24) + seed * 17.0);
    float dropRadius = dropAge * (0.18 + seed * 0.12);
    float dropDistance = length(p - center);
    float dropRing = exp(-abs(dropDistance - dropRadius) * 42.0) * exp(-dropAge * 1.7);
    rainImpact = sin((dropDistance - dropRadius) * 36.0) * dropRing * rain * u_eventStrength * 0.008;
  }
  float fishSwim = step(7.5, u_event) * (1.0 - step(8.5, u_event));
  float fishJump = step(10.5, u_event) * (1.0 - step(11.5, u_event));
  float fishLife = max(fishSwim, fishJump);
  if (fishLife > 0.001) {
    float fishAspect = u_resolution.x / u_resolution.y;
    float eventProgress = clamp(u_eventCycleTime / max(u_eventCycleDuration, 0.1), 0.0, 1.0);
    float fishDepth = mix(3.7, 2.8, fishJump);
    float fishScreenX = mix(-0.12, 1.12, eventProgress);
    vec2 fishPoint = vec2((fishScreenX - 0.5) * fishAspect * fishDepth * 1.6, fishDepth);
    float fishAge = fishJump > 0.5 ? max(u_eventCycleTime - 5.0, 0.0) : mod(u_eventCycleTime, 2.3);
    float wakeDistance = p.x - fishPoint.x;
    float fishWake = exp(-abs(abs(p.y - fishPoint.y) - (0.016 + max(wakeDistance, 0.0) * 0.04)) * 42.0)
      * exp(-max(wakeDistance, 0.0) * 2.4) * step(0.0, wakeDistance) * 0.0025;
    float ringFront = length(p - fishPoint) - fishAge * 0.34;
    float fishRipple = sin(ringFront * 26.0) * exp(-abs(ringFront) * 5.0) * exp(-fishAge * 0.82) * 0.008;
    float rippleStarts = mix(1.0, step(5.0, u_eventCycleTime), fishJump);
    rainImpact += (fishWake * (1.0 - fishJump) + fishRipple * rippleStarts) * fishLife * u_eventStrength;
  }
  float dolphinEvent = step(8.5, u_event) * (1.0 - step(9.5, u_event));
  float dolphinProgress = clamp((u_eventCycleTime - 0.12) / 3.05, 0.0, 1.0);
  float dolphinX = u_eventDirection > 0.0
    ? mix(-0.16, 0.78, dolphinProgress)
    : mix(1.16, 0.22, dolphinProgress);
  float dolphinSplashAge = u_eventCycleTime - 3.1;
  if (dolphinEvent > 0.5 && dolphinSplashAge >= 0.0 && dolphinSplashAge < 3.8) {
    float aspect = u_resolution.x / u_resolution.y;
    float depth = 1.0 / 22.2;
    vec2 dolphinPoint = vec2((dolphinX - 0.5) * aspect * 22.2 * 1.6, 22.2);
    float ringFront = length(p - dolphinPoint) - dolphinSplashAge * 0.22;
    float envelope = exp(-abs(ringFront) * 5.2) * exp(-dolphinSplashAge * 0.72);
    float ringWave = sin(ringFront * 25.0);
    float ringDerivative = (25.0 * cos(ringFront * 25.0) - 5.2 * sign(ringFront) * ringWave) * envelope;
    rainImpact += ringWave * envelope * dolphinEvent * u_eventStrength * depth * 0.28;
    dolphinImpactSlope += (p - dolphinPoint) / max(length(p - dolphinPoint), 0.001)
      * ringDerivative * dolphinEvent * u_eventStrength * depth * 0.28;
  }
  float springLeaves = step(15.5, u_event) * (1.0 - step(16.5, u_event));
  float autumnLeaves = max(step(17.5, u_event) * (1.0 - step(18.5, u_event)),
    step(26.5, u_event) * (1.0 - step(27.5, u_event)));
  float winterSnow = step(18.5, u_event) * (1.0 - step(19.5, u_event));
  float seasonalWake = max(max(springLeaves, autumnLeaves), winterSnow);
  float leafImpact = 0.0;
  vec2 leafImpactSlope = vec2(0.0);
  float snowImpact = 0.0;
  if (seasonalWake > 0.001) {
    float aspect = u_resolution.x / u_resolution.y;
    for (int i = 0; i < 6; i++) {
      float index = float(i);
      float seedX = fract(index * 0.7548776662 + u_eventVariant * 0.569840291 + 0.17320508);
      float seedY = fract(index * 0.43857902 + u_eventVariant * 0.6823278 + 0.283);
      float cycle = 20.0 + seedX * 10.0;
      float shiftedAge = u_eventTime + seedY * cycle;
      float cycleIndex = floor(shiftedAge / cycle);
      float phase = mod(shiftedAge, cycle);
      float flightX = fract(seedX + cycleIndex * 0.61803398875 + u_eventVariant * 0.13);
      float flightY = fract(seedY + cycleIndex * 0.41421356237 + u_eventVariant * 0.07);
      float fallDuration = 2.2 + flightY;
      float impactAge = phase - fallDuration;
      if (impactAge >= 0.0 && impactAge < 3.2) {
        float landingY = u_horizon + 0.025 + flightY * max(0.025, 0.94 - u_horizon);
        float depth = max((landingY - u_horizon) / (1.0 - u_horizon), 0.045);
        float distance = 1.0 / depth;
        float landingX = fract(flightX + u_eventDirection * (0.025 + flightX * 0.03)
          + sin(u_eventTime * 0.48 + index * 1.7) * 0.008);
        vec2 impactPoint = vec2((landingX - 0.5) * aspect * distance * 1.6, distance);
        float impactDistance = length(p - impactPoint);
        float ringFront = impactDistance - impactAge * 0.34;
        float envelope = exp(-abs(ringFront) * 4.8) * exp(-impactAge * 0.85);
        float impactWave = sin(ringFront * 28.0);
        float impactSplash = exp(-impactAge * 7.0) * exp(-impactDistance * 16.0);
        float impactRing = impactWave * envelope + impactSplash * 0.28;
        float impactDerivative = (28.0 * cos(ringFront * 28.0) - 4.8 * sign(ringFront) * impactWave) * envelope
          - impactSplash * 16.0 * 0.28;
        leafImpact += impactRing * max(springLeaves, autumnLeaves);
        leafImpactSlope += (p - impactPoint) / max(length(p - impactPoint), 0.001)
          * impactDerivative * max(springLeaves, autumnLeaves);
        snowImpact += impactRing * winterSnow;
      }
    }
    leafImpact = leafImpact * u_eventStrength * 0.055;
    leafImpactSlope = leafImpactSlope * u_eventStrength * 0.055;
    snowImpact = snowImpact * u_eventStrength * 0.012;
  }
  float calmWaterMotion = 0.62;
  float windDrivenMotion = 0.80 * wind;
  slope = baseSlope * (calmWaterMotion + windDrivenMotion) * u_waveStrength
    + pointerSlope + dolphinImpactSlope + leafImpactSlope
    + fineDirection * (18.0 * cos(rainChopPhase) * rainChopAmplitude);
  return (longSwell + secondarySwell + diagonalSwell + independentSwell + windLines + crossChop + smallChop)
      * (calmWaterMotion + windDrivenMotion) * u_waveStrength
    + pointerRipple + rainChop + rainImpact + leafImpact + snowImpact;
}

float circle(vec2 p, vec2 center, float radius, float softness) {
  return 1.0 - smoothstep(radius - softness, radius + softness, length(p - center));
}

float segment(vec2 p, vec2 a, vec2 b, float radius) {
  vec2 ab = b - a;
  float along = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.00001), 0.0, 1.0);
  return 1.0 - smoothstep(radius, radius + 0.0014, length(p - (a + ab * along)));
}

float birdShape(vec2 p, vec2 center, float size, float wingLift) {
  vec2 point = p - center;
  float leftWing = segment(point, vec2(-size, wingLift), vec2(0.0, 0.0), 0.0008);
  float rightWing = segment(point, vec2(0.0, 0.0), vec2(size, wingLift), 0.0008);
  return max(leftWing, rightWing);
}

float eventMask(float id) {
  return 1.0 - smoothstep(0.1, 0.25, abs(u_event - id));
}

float ellipse(vec2 p, vec2 center, vec2 radius) {
  return 1.0 - smoothstep(0.88, 1.0, length((p - center) / radius));
}

float toriiMaterialMask(vec3 sourceColor, vec2 point) {
  float bounds = smoothstep(0.36, 0.39, point.x) * (1.0 - smoothstep(0.61, 0.64, point.x))
    * smoothstep(0.30, 0.34, point.y) * (1.0 - smoothstep(0.55, 0.58, point.y));
  float luminance = dot(sourceColor, vec3(0.299, 0.587, 0.114));
  float darkStructure = 1.0 - smoothstep(0.36, 0.49, luminance);
  float vermilion = smoothstep(0.035, 0.12, sourceColor.r - sourceColor.g)
    * smoothstep(0.02, 0.09, sourceColor.r - sourceColor.b);
  return bounds * max(darkStructure * 0.86, vermilion * 0.94);
}

vec2 portalWarpUv(vec2 sampleUv, float aspect, float progress, float time, float exitWarp) {
  vec2 portalSpace = vec2((sampleUv.x - 0.5) * aspect, (sampleUv.y - 0.45) / 1.30);
  float portalRadius = length(portalSpace);
  float portalFalloff = 1.0 - smoothstep(0.0, 0.92, portalRadius);
  vec2 portalDirection = portalSpace / max(portalRadius, 0.001);
  vec2 portalTangent = vec2(-portalDirection.y, portalDirection.x);
  float portalAngle = atan(portalSpace.y, portalSpace.x);
  float portalWave = sin(portalAngle * 2.2 + portalRadius * 46.0 - progress * 25.0
    - time * (0.35 + progress * 0.85)) * portalFalloff * progress;
  float portalSuction = smoothstep(0.0, 1.0, progress) * portalFalloff;
  float portalPull = portalSuction * (0.045 + progress * 0.405);
  float portalTwist = sin(portalAngle * 3.0 + portalRadius * 34.0 - progress * 31.0
    - time * (0.45 + progress * 1.15)) * portalFalloff * progress * 0.135;
  vec2 portalRadialFlow = vec2(portalDirection.x / max(aspect, 0.08), portalDirection.y * 1.30);
  vec2 portalSwirlFlow = vec2(portalTangent.x / max(aspect, 0.08), portalTangent.y * 1.30);
  vec2 warpedUv = sampleUv + portalRadialFlow * (portalPull + portalWave * 0.055)
    + portalSwirlFlow * (portalTwist + portalFalloff * progress * 0.15);
  float clothPinch = sin(portalAngle * 2.8 + portalRadius * 31.0 - time * 1.4
    + sin(time * 0.42 + portalAngle) * 0.7);
  float clothRipple = sin(portalAngle * 5.0 - portalRadius * 44.0 + time * 1.9);
  vec2 fabricFold = portalSwirlFlow * clothPinch * 0.105 + portalRadialFlow * clothRipple * 0.04;
  return clamp(warpedUv + fabricFold * exp(-portalRadius * 6.0) * exitWarp, vec2(0.001), vec2(0.999));
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  float photoAspect = u_photoSize.x / u_photoSize.y;
  vec2 photoScale = vec2(1.0);
  if (aspect > photoAspect) {
    photoScale.y = photoAspect / aspect;
  } else {
    photoScale.x = aspect / photoAspect;
  }
  vec2 uv = 0.5 + (v_uv - 0.5) * photoScale;

  float progress = clamp(u_progress, 0.0, 1.0);
  float fogEvent = eventMask(1.0);
  float nightRain = eventMask(2.0);
  float dayRain = eventMask(3.0);
  float clearDay = eventMask(4.0);
  float overcastEvent = eventMask(5.0);
  float stormEvent = eventMask(6.0);
  float ghostEvent = eventMask(7.0);
  float swiftEvent = eventMask(10.0);
  float gustEvent = eventMask(12.0);
  float distantRain = eventMask(13.0);
  float auroraEvent = eventMask(14.0);
  float springEvent = eventMask(16.0);
  float summerEvent = eventMask(17.0);
  float autumnEvent = eventMask(18.0);
  float winterEvent = eventMask(19.0);
  float mossEvent = eventMask(20.0);
  float murkyWaterEvent = eventMask(21.0);
  float clearWaterEvent = eventMask(22.0);
  float meteorEvent = eventMask(23.0);
  float meteorShowerEvent = eventMask(24.0);
  float solarEclipseEvent = eventMask(25.0);
  float lunarEclipseEvent = eventMask(26.0);
  float leafStormEvent = eventMask(27.0);
  float lightningOnlyEvent = eventMask(28.0);
  float cloudWeather = max(stormEvent, max(distantRain, nightRain + dayRain));
  float cloudGather = smoothstep(0.0, 36.0, u_eventTime);
  float cloudRelease = 1.0 - smoothstep(u_eventDuration - 44.0, u_eventDuration - 10.0, u_eventTime);
  float weatherLife = u_eventStrength * (0.12 + cloudGather * 0.88) * cloudRelease;
  float particleLife = u_eventStrength * smoothstep(0.0, 20.0, u_eventTime)
    * (1.0 - smoothstep(u_eventDuration - 55.0, u_eventDuration - 15.0, u_eventTime));
  float cloudCover = clamp(max((stormEvent * 1.0 + distantRain * 0.52 + (nightRain + dayRain) * 0.42) * weatherLife,
    u_weatherCloudCover * 0.82), 0.0, 1.0);
  float weatherCloud = max((stormEvent * 0.94 + distantRain * 0.34 + (nightRain + dayRain) * 0.26) * weatherLife,
    u_weatherCloudCover * 0.62);
  float rainGather = smoothstep(28.0, 76.0, u_eventTime);
  float rainRelease = 1.0 - smoothstep(u_eventDuration - 60.0, u_eventDuration - 20.0, u_eventTime);
  float rainfall = (nightRain * 0.34 + dayRain * 0.52 + stormEvent * 0.92 + distantRain * 0.38) * weatherLife * rainGather * rainRelease;
  float ambientTime = u_time * (1.0 - u_reducedMotion);
  float topY = 1.0 - v_uv.y;
  float waterMask = smoothstep(u_horizon - 0.008, u_horizon + 0.008, topY);
  float depth = clamp((topY - u_horizon) / (1.0 - u_horizon), 0.0, 1.0);
  float waterDistance = 1.0 / max(depth, 0.045);
  vec2 waterPoint = vec2((v_uv.x - 0.5) * aspect * waterDistance * 1.6, waterDistance);
  vec2 windDirection = normalize(u_windDirection);
  float height = 0.0;
  vec2 slope = vec2(0.0);
  if (waterMask > 0.001) height = waveHeight(waterPoint, u_time, u_windStrength, windDirection, slope);
  float slopeX = slope.x;
  float slopeY = slope.y;
  vec2 normal = vec2(-slopeX, -slopeY) * 0.82;
  float perspective = mix(0.20, 1.18, smoothstep(0.0, 1.0, depth));
  vec2 waterDisplacement = vec2(normal.x * 0.36, -normal.y * 0.11) * perspective;
  float surfaceDisplacementMask = waterMask;
  vec2 photoUv = clamp(uv + waterDisplacement * surfaceDisplacementMask, vec2(0.001), vec2(0.999));
  vec2 portalDelta = photoUv - vec2(0.5, 0.45);
  vec2 portalSpace = vec2(portalDelta.x * aspect, portalDelta.y / 1.30);
  float portalRadius = length(portalSpace);
  float portalAngle = atan(portalSpace.y, portalSpace.x);
  float exitWarp = smoothstep(0.62, 0.99, u_portalProgress) * smoothstep(0.30, 1.25, u_portalLight);
  photoUv = portalWarpUv(photoUv, aspect, u_portalProgress, u_time, exitWarp);
  vec3 color = texture2D(u_photo, photoUv).rgb;
  float japanAspect = u_japanSize.x / u_japanSize.y;
  vec2 japanScale = vec2(1.0);
  if (aspect > japanAspect) {
    japanScale.y = japanAspect / aspect;
  } else {
    japanScale.x = aspect / japanAspect;
  }
  vec2 japanUv = vec2(0.5 + (v_uv.x - 0.5) * japanScale.x,
                       1.0 - clamp(0.04 + topY * 1.30, 0.001, 0.999));
  vec3 japanSky = texture2D(u_japan, japanUv).rgb;
  float skyBackplate = (1.0 - smoothstep(u_horizon - 0.055, u_horizon + 0.045, topY)) * u_japanBlend;
  float gatePreserve = toriiMaterialMask(color, vec2(v_uv.x, topY)) * u_guardTorii;
  color = mix(color, japanSky, skyBackplate * (1.0 - gatePreserve));
  float shorelineBand = smoothstep(u_horizon - 0.055, u_horizon + 0.018, topY)
    * (1.0 - smoothstep(u_horizon + 0.115, u_horizon + 0.18, topY));
  float gateMoss = 0.0;
  if (mossEvent > 0.001 && u_guardTorii > 0.5) {
    float mossGrain = fbm(vec2(v_uv.x * 82.0, topY * 76.0 + u_eventTime * 0.012));
    gateMoss = gatePreserve * shorelineBand * smoothstep(0.49, 0.75, mossGrain) * mossEvent * u_eventStrength;
  }
  color = mix(color, vec3(0.20, 0.28, 0.17), gateMoss * 0.48);
  float reflectedTop = clamp(2.0 * u_horizon - topY, 0.0, 1.0);
  vec2 reflectedScreenUv = vec2(v_uv.x, 1.0 - reflectedTop);
  vec2 reflectedPhotoUv = 0.5 + (reflectedScreenUv - 0.5) * photoScale;
  reflectedPhotoUv = clamp(reflectedPhotoUv + waterDisplacement * surfaceDisplacementMask, vec2(0.001), vec2(0.999));
  reflectedPhotoUv = portalWarpUv(reflectedPhotoUv, aspect, u_portalProgress, u_time, exitWarp);
  vec3 reflection = texture2D(u_photo, reflectedPhotoUv).rgb;
  vec2 reflectedNorwayUv = vec2(0.5 + (reflectedScreenUv.x - 0.5) * japanScale.x,
                                 1.0 - clamp(0.04 + reflectedTop * 1.30, 0.001, 0.999));
  vec3 reflectedNorway = texture2D(u_japan, reflectedNorwayUv).rgb;
  float reflectedGate = toriiMaterialMask(reflection, vec2(v_uv.x, reflectedTop)) * u_guardTorii;
  float reflectedSkyPlate = (1.0 - smoothstep(u_horizon - 0.055, u_horizon + 0.045, reflectedTop)) * u_japanBlend;
  reflection = mix(reflection, reflectedNorway, reflectedSkyPlate * (1.0 - reflectedGate));
  float dawn = smoothstep(0.19, 0.24, progress) * (1.0 - smoothstep(0.28, 0.33, progress));
  float warmEvening = smoothstep(0.68, 0.73, progress) * (1.0 - smoothstep(0.80, 0.84, progress));
  float dusk = smoothstep(0.73, 0.77, progress) * (1.0 - smoothstep(0.79, 0.83, progress));
  float night = max(1.0 - smoothstep(0.20, 0.25, progress), smoothstep(0.75, 0.80, progress));
  float day = 1.0 - max(max(dawn, warmEvening), max(dusk, night));
  reflection = mix(reflection, reflection * vec3(0.15, 0.24, 0.40), night * 0.68);
  reflection = mix(reflection, reflection * vec3(1.08, 0.78, 0.58), warmEvening * 0.30);
  float reflectionStrength = mix(0.82, 0.96, smoothstep(0.0, 1.0, depth));
  reflectionStrength = mix(reflectionStrength, min(1.0, reflectionStrength + 0.08), clearWaterEvent * u_eventStrength);

  float algaeStrength = max(murkyWaterEvent, mossEvent * 0.24) * u_eventStrength;
  if (algaeStrength > 0.001) {
    float algaeField = fbm(waterPoint * 0.16 + vec2(ambientTime * 0.012, -ambientTime * 0.008));
    float algaePatches = smoothstep(0.54, 0.78, algaeField) * smoothstep(0.04, 0.36, depth);
    color = mix(color, mix(color, vec3(0.22, 0.30, 0.23), 0.34 + algaeField * 0.20), waterMask * algaePatches * algaeStrength * 0.62);
  }
  color = mix(color, vec3(0.31, 0.35, 0.31), waterMask * murkyWaterEvent * u_eventStrength * 0.30);
  color = mix(color, color * vec3(1.07, 1.08, 1.06), waterMask * clearWaterEvent * u_eventStrength * 0.16);

  float highSky = 1.0 - smoothstep(0.0, u_horizon, 1.0 - v_uv.y);
  vec3 skyWarmth = vec3(1.0, 0.68, 0.46) * (0.20 * dawn + 0.25 * warmEvening + 0.13 * dusk);
  color += skyWarmth * (1.0 - waterMask) * (0.4 + highSky * 0.6);
  vec3 skyBlue = mix(vec3(0.36, 0.57, 0.72), vec3(0.19, 0.38, 0.55), highSky);
  color = mix(color, skyBlue, day * (1.0 - waterMask) * 0.25);
  color = mix(color, color * vec3(0.08, 0.15, 0.32) + vec3(0.012, 0.022, 0.065), night * (1.0 - waterMask) * 0.78);
  color = mix(color, color * vec3(1.10, 0.78, 0.57), warmEvening * (1.0 - waterMask) * 0.36);
  color = mix(color, color * vec3(0.88, 0.66, 0.68), dusk * (1.0 - waterMask) * 0.30);
  color = mix(color, color * vec3(0.70, 0.75, 0.79), weatherCloud * (1.0 - waterMask) * 0.48);
  color = mix(color, color * vec3(0.48, 0.55, 0.62), cloudCover * (1.0 - waterMask) * 0.46);

  float sunTravel = clamp((progress - 0.25) / 0.50, 0.0, 1.0);
  vec2 sun = vec2(mix(0.055, 0.945, sunTravel), u_horizon - 0.035 - sin(sunTravel * 3.14159) * 0.32);
  float sunrise = 1.0 - smoothstep(0.2083, 0.27, progress);
  float sunset = smoothstep(0.73, 0.77, progress) * (1.0 - smoothstep(0.77, 0.81, progress));
  float sunVisibility = smoothstep(0.22, 0.26, progress) * (1.0 - smoothstep(0.74, 0.78, progress));
  sunVisibility *= 1.0 + clearDay * u_eventStrength * 0.16;
  sunVisibility *= 1.0 - cloudCover * 0.97;
  float moonTravel = mod(progress + 0.25, 1.0) / 0.5;
  vec2 moonArc = vec2(mix(0.055, 0.945, moonTravel),
                      u_horizon - 0.045 - sin(moonTravel * 3.14159) * 0.24);
  float moonVisibility = smoothstep(0.75, 0.79, progress) * (1.0 - smoothstep(0.21, 0.25, progress));
  vec2 skyPoint = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 sunCoord = (skyPoint - sun) * vec2(aspect, 1.0) / 0.013;
  float sunRadiusSq = dot(sunCoord, sunCoord);
  float sunDisk = 1.0 - smoothstep(0.78, 1.10, sunRadiusSq);
  vec3 sunColor = mix(vec3(0.93, 0.48, 0.31), vec3(0.96, 0.83, 0.65), smoothstep(0.10, 0.42, day));
  if (sunRadiusSq < 1.0) {
    vec3 sunNormal = normalize(vec3(sunCoord.x, -sunCoord.y, sqrt(max(0.0, 1.0 - sunRadiusSq))));
    float limbLight = 0.92 + 0.08 * max(dot(sunNormal, normalize(vec3(-0.25, 0.35, 0.90))), 0.0);
    sunColor *= 0.94 + limbLight * 0.06;
  }
  float sunHalo = exp(-length((skyPoint - sun) * vec2(aspect, 0.9)) * 10.0) * sunVisibility;
  float sunAura = exp(-length((skyPoint - sun) * vec2(aspect, 0.75)) * 3.3) * sunVisibility;
  color += mix(vec3(0.92, 0.52, 0.37), vec3(0.91, 0.81, 0.68), day) * sunAura * (1.0 - waterMask) * mix(0.045, 0.075, max(sunrise, sunset));
  color += sunColor * sunHalo * (1.0 - waterMask) * 0.045;
  color = mix(color, sunColor * 0.94, sunDisk * sunVisibility * (1.0 - waterMask) * 0.62);
  float solarProgress = clamp(u_eventTime / max(u_eventDuration, 0.1), 0.0, 1.0);
  vec2 eclipseSunOffset = vec2(mix(-0.023, 0.023, smoothstep(0.10, 0.90, solarProgress)), 0.0);
  vec2 eclipseMoonCoord = (skyPoint - sun - eclipseSunOffset) * vec2(aspect, 1.0) / 0.013;
  float eclipseMoon = 1.0 - smoothstep(0.90, 1.02, length(eclipseMoonCoord));
  float eclipseCorona = exp(-abs(length(eclipseMoonCoord) - 1.16) * 14.0);
  float solarStrength = solarEclipseEvent * u_eventStrength;
  color += vec3(1.0, 0.73, 0.42) * eclipseCorona * solarStrength * (1.0 - waterMask) * 0.24;
  color = mix(color, vec3(0.009, 0.012, 0.018), eclipseMoon * solarStrength * (1.0 - waterMask));
  color *= 1.0 - solarStrength * 0.16 * (1.0 - waterMask * 0.45);

  moonVisibility *= 0.76;
  vec2 moonCoord = (skyPoint - moonArc) * vec2(aspect, 1.0) / 0.014;
  float moonRadiusSq = dot(moonCoord, moonCoord);
  float moonDisk = 1.0 - smoothstep(0.95, 1.0, moonRadiusSq);
  vec3 moonNormal = vec3(moonCoord.x, -moonCoord.y, sqrt(max(0.0, 1.0 - moonRadiusSq)));
  vec3 moonColor = vec3(0.45, 0.46, 0.48);
  if (moonRadiusSq < 1.0 && moonVisibility > 0.001) {
    vec2 moonUv = vec2(atan(moonNormal.x, moonNormal.z) / 6.2831853 + 0.5,
                       asin(clamp(moonNormal.y, -1.0, 1.0)) / 3.14159265 + 0.5);
    float moonLight = max(dot(normalize(moonNormal), normalize(vec3(-0.48, 0.36, 0.80))), 0.0);
    vec3 craterDetail = texture2D(u_moonMap, moonUv).rgb;
    vec3 mutedMoon = mix(vec3(0.50, 0.53, 0.57), craterDetail, 0.28);
    moonColor = mutedMoon * (0.42 + 0.42 * moonLight) + vec3(0.16, 0.18, 0.21);
    moonColor += vec3(0.05, 0.06, 0.08) * sqrt(max(0.0, 1.0 - moonRadiusSq));
  }
  float lunarProgress = clamp(u_eventTime / max(u_eventDuration, 0.1), 0.0, 1.0);
  vec2 earthShadowCenter = vec2(mix(-1.35, 1.35, smoothstep(0.12, 0.88, lunarProgress)), 0.0);
  float earthShadowDistance = length(moonCoord - earthShadowCenter);
  float earthShadow = 1.0 - smoothstep(0.80, 1.12, earthShadowDistance);
  float lunarStrength = lunarEclipseEvent * u_eventStrength * moonVisibility;
  moonColor = mix(moonColor, vec3(0.20, 0.035, 0.018), earthShadow * lunarStrength * 0.94);
  moonColor += vec3(0.22, 0.045, 0.018) * exp(-abs(earthShadowDistance - 0.98) * 9.0) * lunarStrength * 0.10;
  float moonHalo = exp(-length((skyPoint - moonArc) * vec2(aspect, 0.8)) * 10.0) * moonVisibility;
  float moonAura = exp(-length((skyPoint - moonArc) * vec2(aspect, 0.8)) * 3.8) * moonVisibility;
  color += vec3(0.48, 0.60, 0.78) * moonAura * (1.0 - waterMask) * 0.16;
  color += vec3(0.61, 0.72, 0.88) * moonHalo * (1.0 - waterMask) * 0.12;
  color = mix(color, moonColor, moonDisk * moonVisibility * (1.0 - waterMask) * 0.92);

  vec2 cloudPoint = vec2(skyPoint.x * 2.35 + ambientTime * (0.0035 + u_windStrength * 0.009) * windDirection.x + progress * 0.46,
                         skyPoint.y * 5.4 + 0.65);
  float cloudA = fbm(cloudPoint);
  float cloudB = fbm(cloudPoint * 1.8 + vec2(2.1, -1.3));
  float cloudField = cloudA * 0.72 + cloudB * 0.28;
  float cloudCoverage = clamp(0.16 + cloudCover * 0.82, 0.0, 0.98);
  float cloudThreshold = mix(0.72, 0.37, cloudCoverage);
  float cloudShape = smoothstep(cloudThreshold, cloudThreshold + 0.20, cloudField);
  float cloudTufts = smoothstep(cloudThreshold - 0.14, cloudThreshold + 0.12, cloudA * 0.58 + cloudB * 0.42);
  float cloudHeight = u_horizon - skyPoint.y;
  float lowCloudBand = smoothstep(0.002, 0.055, cloudHeight)
    * (1.0 - smoothstep(0.22, 0.38, cloudHeight));
  float highCloudBand = smoothstep(0.12, 0.23, cloudHeight)
    * (1.0 - smoothstep(0.41, 0.52, cloudHeight));
  float cloudBand = max(lowCloudBand, highCloudBand * 0.72);
  float cloudMask = max(cloudShape * 0.72, cloudTufts * 0.54) * cloudBand * (1.0 - waterMask)
    * (0.14 + weatherCloud * 0.92) * (1.0 - clearDay * u_eventStrength * 0.62);
  vec3 cloudTint = mix(vec3(0.95, 0.69, 0.54), vec3(0.78, 0.84, 0.89), night);
  cloudTint = mix(cloudTint, vec3(0.49, 0.55, 0.60), clamp(weatherCloud * 1.05, 0.0, 0.92));
  cloudTint *= mix(0.70, 1.12, smoothstep(cloudThreshold, 0.88, cloudField));
  color = mix(color, cloudTint, cloudMask);
  float shadowField = fbm(vec2(skyPoint.x * 2.1 - ambientTime * (0.003 + u_windStrength * 0.008) * windDirection.x,
                               skyPoint.y * 4.1 + 1.8));
  float cloudShadow = smoothstep(0.48, 0.72, shadowField) * cloudCover;
  color *= 1.0 - cloudShadow * (0.07 + waterMask * 0.22);
  vec2 reflectedCloudPoint = vec2(reflectedScreenUv.x * 2.35 + ambientTime * (0.0035 + u_windStrength * 0.009) * windDirection.x + progress * 0.46,
                                  reflectedTop * 5.4 + 0.65);
  float reflectedCloudA = fbm(reflectedCloudPoint);
  float reflectedCloudB = fbm(reflectedCloudPoint * 1.8 + vec2(2.1, -1.3));
  float reflectedCloudShape = smoothstep(cloudThreshold, cloudThreshold + 0.20, reflectedCloudA * 0.72 + reflectedCloudB * 0.28);
  float reflectedCloudHeight = u_horizon - reflectedTop;
  float reflectedCloudBand = max(smoothstep(0.002, 0.055, reflectedCloudHeight) * (1.0 - smoothstep(0.22, 0.38, reflectedCloudHeight)),
    smoothstep(0.12, 0.23, reflectedCloudHeight) * (1.0 - smoothstep(0.41, 0.52, reflectedCloudHeight)) * 0.72);
  float reflectedCloudMask = reflectedCloudShape * reflectedCloudBand * waterMask * (0.055 + cloudCover * 0.40);
  reflection = mix(reflection, cloudTint, reflectedCloudMask);
  float toriiReflectionMask = waterMask * reflectionStrength * u_guardTorii;
  color = mix(color, mix(reflection, color, 0.075), toriiReflectionMask);

  float morningMist = dawn;
  float eveningMist = smoothstep(0.68, 0.75, progress) * (1.0 - smoothstep(0.82, 0.90, progress));
  float fogNoise = fbm(vec2(v_uv.x * 3.4 + ambientTime * 0.007, topY * 12.0 + ambientTime * 0.013));
  float ridgeDistance = abs((topY - u_horizon) - (fogNoise - 0.5) * 0.11);
  float lowMistBand = exp(-ridgeDistance * 19.0);
  float upperMistBand = exp(-abs(topY - (u_horizon - 0.16 + (fogNoise - 0.5) * 0.10)) * 9.0);
  float mistBand = max(lowMistBand, upperMistBand * 0.58);
  float mistTexture = cloudA * 0.45 + cloudB * 0.30 + fogNoise * 0.25;
  float fogBuild = smoothstep(0.0, 36.0, u_eventTime)
    * (1.0 - smoothstep(u_eventDuration - 65.0, u_eventDuration - 20.0, u_eventTime));
  float eventMist = (fogEvent * 0.62 + ghostEvent * 0.52) * u_eventStrength * fogBuild
    + (stormEvent * 0.20 + distantRain * 0.24) * weatherLife;
  float mist = clamp((morningMist * 0.18 + eveningMist * 0.14 + u_windStrength * 0.09 + eventMist)
    * mistBand * (0.42 + mistTexture * 0.70), 0.0, 0.72);
  vec3 mistTint = mix(vec3(0.76, 0.84, 0.88), vec3(0.94, 0.70, 0.60), eveningMist);
  color = mix(color, mistTint, mist * (1.0 - waterMask * 0.62));

  float rainDepth = smoothstep(0.0, 1.0, skyPoint.y);
  float rainSpeed = mix(1.0, 4.0, rainDepth) * (1.0 + stormEvent * 0.8);
  float rainClusters = 0.0;
  if (rainfall > 0.001) {
    float rainClusterField = fbm(vec2(skyPoint.x * 4.8 - ambientTime * 0.018 * windDirection.x,
                                      skyPoint.y * 2.7 + ambientTime * 0.009));
    rainClusters = smoothstep(0.43, 0.70, rainClusterField) * (0.18 + cloudMask * 1.8);
  }
  vec2 rainGrid = vec2((skyPoint.x * aspect + skyPoint.y * 0.11 + (cloudA - 0.5) * 0.23) * mix(36.0, 58.0, rainDepth),
                       skyPoint.y * mix(18.0, 35.0, rainDepth) + ambientTime * rainSpeed);
  vec2 rainCell = floor(rainGrid);
  vec2 rainLocal = fract(rainGrid);
  float rainSeed = hash21(rainCell);
  float rainRow = fract(rainLocal.y + rainSeed * 0.83);
  float rainColumn = fract(rainLocal.x + hash21(rainCell + vec2(8.3)) * 0.72);
  float rainSlant = 0.07 + u_windStrength * 0.16 + stormEvent * 0.12;
  float rainWidth = mix(0.012, 0.050, rainDepth) * (0.65 + rainSeed * 0.75);
  float rainLength = mix(0.14, 0.42, rainDepth) * (0.60 + rainSeed * 0.85);
  float rainStroke = (1.0 - smoothstep(rainWidth, rainWidth + 0.035, abs(rainColumn - 0.5 + rainRow * rainSlant)))
    * smoothstep(0.02, 0.12, rainRow) * (1.0 - smoothstep(rainLength, rainLength + 0.16, rainRow))
    * step(0.16, rainSeed) * clamp(rainClusters, 0.0, 1.0);
  color += vec3(0.70, 0.79, 0.86) * rainStroke * rainfall * (0.33 + stormEvent * 0.50);
  float lightningBeat = mod(u_eventTime, 64.0);
  float lightningPulse = exp(-abs(lightningBeat - 38.0) * 19.0) + exp(-abs(lightningBeat - 38.18) * 25.0)
    + exp(-abs(lightningBeat - 52.0) * 14.0) + exp(-abs(lightningBeat - 52.48) * 24.0);
  float lightning = lightningPulse * max(stormEvent, lightningOnlyEvent) * weatherLife;
  float lightningPathX = 0.32 + sin(u_eventTime * 1.6) * 0.045;
  float lightningBranch = segment(vec2(skyPoint.x * aspect, skyPoint.y), vec2(lightningPathX * aspect, u_horizon - 0.38), vec2((lightningPathX - 0.025) * aspect, u_horizon - 0.08), 0.0014)
    + segment(vec2(skyPoint.x * aspect, skyPoint.y), vec2((lightningPathX - 0.012) * aspect, u_horizon - 0.22), vec2((lightningPathX - 0.057) * aspect, u_horizon - 0.17), 0.0008)
    + segment(vec2(skyPoint.x * aspect, skyPoint.y), vec2((lightningPathX - 0.020) * aspect, u_horizon - 0.14), vec2((lightningPathX + 0.022) * aspect, u_horizon - 0.10), 0.0007);
  float lightningBolt = lightningBranch * smoothstep(0.04, 0.18, lightning) * max(stormEvent, lightningOnlyEvent) * weatherLife;
  color += vec3(0.61, 0.76, 0.96) * lightningBolt * (1.0 - waterMask) * 0.88;
  color += vec3(0.39, 0.56, 0.78) * lightningBolt * waterMask * 0.06;
  color = mix(color, vec3(0.73, 0.80, 0.87), lightning * 0.19 * (1.0 - waterMask));

  float auroraNoise = 0.5;
  if (auroraEvent > 0.001) auroraNoise = fbm(vec2(v_uv.x * 3.5 + ambientTime * 0.025, v_uv.y * 2.2 + ambientTime * 0.012));
  float auroraWave = sin(v_uv.x * 18.0 + ambientTime * 0.16 + auroraNoise * 2.4) * 0.024;
  float auroraBand = smoothstep(0.25, 0.43, topY) * (1.0 - smoothstep(0.49 + auroraWave, 0.56 + auroraWave, topY));
  float aurora = auroraBand * auroraEvent * u_eventStrength * (0.36 + auroraNoise * 0.64);
  vec3 auroraColor = mix(vec3(0.22, 0.52, 0.44), vec3(0.43, 0.38, 0.68), smoothstep(0.44, 0.64, auroraNoise));
  color += auroraColor * aurora * (1.0 - waterMask) * 0.20;
  color += auroraColor * aurora * waterMask * 0.075;

  vec2 meteorPoint = vec2(skyPoint.x * aspect, skyPoint.y);
  float meteorProgress = clamp((u_eventCycleTime - 0.65) / 2.7, 0.0, 1.0);
  vec2 meteorStart = vec2((0.96 - u_eventVariant * 0.10) * aspect, u_horizon - 0.35 + u_eventVariant * 0.11);
  vec2 meteorEnd = meteorStart + vec2(-0.44 - u_eventVariant * 0.18, 0.20 + u_eventVariant * 0.08);
  vec2 meteorHead = mix(meteorStart, meteorEnd, meteorProgress);
  vec2 meteorDirection = normalize(meteorEnd - meteorStart);
  float meteorLength = mix(0.10, 0.32, u_eventVariant);
  vec2 meteorTail = meteorHead - meteorDirection * meteorLength;
  float meteorTrail = segment(meteorPoint, meteorTail, meteorHead, mix(0.00055, 0.0017, u_eventVariant));
  float meteorHeadGlow = exp(-length(meteorPoint - meteorHead) * 150.0);
  float meteorFade = smoothstep(0.0, 0.08, meteorProgress) * (1.0 - smoothstep(0.87, 1.0, meteorProgress));
  float singleMeteor = (meteorTrail * 0.52 + meteorHeadGlow) * meteorFade * meteorEvent * u_eventStrength;
  float meteorShower = 0.0;
  if (meteorShowerEvent > 0.001) {
    for (int i = 0; i < 5; i++) {
      float index = float(i);
      float age = u_eventCycleTime - (0.8 + index * 1.65);
      float travel = clamp(age / 1.8, 0.0, 1.0);
      vec2 start = vec2((0.96 - fract(index * 0.31 + u_eventVariant) * 0.42) * aspect,
                        u_horizon - 0.18 - fract(index * 0.57 + u_eventVariant * 0.83) * 0.34);
      vec2 end = start + vec2(-0.22 - fract(index * 0.43) * 0.18, 0.10 + fract(index * 0.37) * 0.14);
      vec2 head = mix(start, end, travel);
      vec2 direction = normalize(end - start);
      vec2 tail = head - direction * (0.075 + fract(index * 0.39) * 0.09);
      float trail = segment(meteorPoint, tail, head, 0.0007 + fract(index * 0.23) * 0.00065);
      float glow = exp(-length(meteorPoint - head) * 128.0);
      float fade = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(1.38, 1.82, age));
      meteorShower += (trail * 0.48 + glow) * fade * step(0.0, age) * (1.0 - step(1.82, age));
    }
  }
  meteorShower *= meteorShowerEvent * u_eventStrength;
  vec3 meteorGlow = mix(vec3(0.68, 0.80, 1.0), vec3(1.0, 0.68, 0.42), u_eventVariant);
  color += meteorGlow * (singleMeteor + meteorShower) * (1.0 - waterMask) * 0.72;
  color += meteorGlow * (singleMeteor + meteorShower) * waterMask * 0.022;

  vec2 seasonalPoint = vec2(v_uv.x * aspect, topY);
  float snowParticles = 0.0;
  if (winterEvent > 0.001) {
    for (int i = 0; i < 24; i++) {
      float index = float(i);
      float seedX = hash21(vec2(index + 2.3, 7.1));
      float seedY = hash21(vec2(index + 14.7, 3.2));
      float startY = u_horizon - 0.08 - seedY * 0.18;
      float landingY = u_horizon + 0.025 + seedY * 0.055;
      float snowSeed = hash21(vec2(index + 31.4, 9.2));
      float snowCycle = 4.5 + seedX * 1.6;
      float snowPhase = mod(u_eventTime + seedX * snowCycle, snowCycle);
      float snowFallDuration = 1.35 + seedY * 1.0;
      float snowImpactAge = max(0.0, snowPhase - snowFallDuration);
      float snowFall = pow(clamp(snowPhase / snowFallDuration, 0.0, 1.0), 1.35);
      float snowWobble = sin(snowPhase * (1.1 + snowSeed * 0.7) + index * 2.1) * 0.004 * (1.0 - snowFall);
      float snowY = mix(startY - 0.10, landingY, snowFall) + snowWobble;
      float snowFlightX = fract(seedX + u_eventTime * windDirection.x * (0.010 + seedY * 0.018)
        + sin(u_eventTime * (0.7 + snowSeed * 0.6) + index * 2.4) * 0.012);
      float snowX = fract(snowFlightX + max(snowImpactAge - 0.1, 0.0) * windDirection.x * (0.003 + seedX * 0.004));
      float snowDepth = smoothstep(u_horizon - 0.20, 0.92, snowY);
      float snowSize = mix(0.0009, 0.0060, snowDepth) * (0.72 + snowSeed * 0.56);
      float snowDepthFactor = max((snowY - u_horizon) / (1.0 - u_horizon), 0.045);
      vec2 snowWaterPoint = vec2((snowX - 0.5) * aspect * (1.0 / snowDepthFactor) * 1.6, 1.0 / snowDepthFactor);
      float snowWave = sin(dot(snowWaterPoint, windDirection) * 1.15 - u_time * 1.35) * 0.052
        + sin(dot(snowWaterPoint, vec2(windDirection.x - 0.13, windDirection.y + 0.20)) * 2.35 - u_time * 2.05) * 0.022;
      float snowLift = snowWave * (0.62 + u_windStrength * 0.80) * u_waveStrength * snowDepthFactor * step(snowFallDuration, snowPhase);
      vec2 snowCenter = vec2(snowX * aspect, snowY + snowLift);
      float snowflake = ellipse(seasonalPoint, snowCenter, vec2(snowSize * (0.78 + snowDepth * 0.6), snowSize));
      float snowVisible = 1.0 - smoothstep(snowFallDuration - 0.02, snowFallDuration + 0.10, snowPhase);
      snowParticles = max(snowParticles, clamp(snowflake, 0.0, 1.0) * snowVisible);
    }
  }
  color += vec3(0.91, 0.96, 1.0) * snowParticles * winterEvent * particleLife * 0.68;

  vec2 fireworkPoint = vec2(skyPoint.x * aspect + normal.x * 0.11 * waterMask,
                            mix(skyPoint.y, reflectedTop, waterMask) + normal.y * 0.025 * waterMask);
  vec3 fireworksLight = vec3(0.0);
  float fireworkGlow = 0.0;
  if (summerEvent > 0.001) {
  for (int i = 0; i < 5; i++) {
    float index = float(i);
    float shellAge = u_eventCycleTime - (0.5 + index * 2.75);
    float launch = clamp(shellAge / 1.25, 0.0, 1.0);
    float burstAge = shellAge - 1.25;
    float burstLife = step(0.0, burstAge) * (1.0 - smoothstep(2.7, 3.5, burstAge));
    float x = 0.19 + fract(index * 0.37 + u_eventVariant * 0.41) * 0.63;
    float centerY = u_horizon - 0.16 - fract(index * 0.53 + u_eventVariant) * 0.19;
    vec2 center = vec2(x * aspect, centerY);
    vec2 launchStart = vec2(x * aspect - 0.07, u_horizon + 0.035);
    vec2 shellHead = mix(launchStart, center, launch);
    float shellTrail = segment(fireworkPoint, shellHead - vec2(0.0, 0.043), shellHead, 0.0015);
    float shellSpark = exp(-length(fireworkPoint - shellHead) * 110.0);

    float afterglow = max(burstAge, 0.0);
    vec2 burstCenter = center + vec2(0.0, max(afterglow - 0.55, 0.0) * max(afterglow - 0.55, 0.0) * 0.014);
    vec2 offset = fireworkPoint - burstCenter;
    float radius = length(offset);
    float angle = atan(offset.y, offset.x);
    float expansion = 0.018 + min(afterglow, 1.35) * (0.040 + fract(index * 0.31) * 0.014);
    float spokes = pow(max(0.0, cos(angle * (13.0 + fract(index * 0.27) * 7.0) + index * 1.7)), 24.0);
    float fineSpokes = pow(max(0.0, cos(angle * 29.0 - index * 2.3)), 30.0);
    float sparkRing = exp(-abs(radius - expansion) * 190.0);
    float innerRing = exp(-abs(radius - expansion * 0.62) * 250.0);
    float sparkFall = (1.0 - smoothstep(0.10, 0.58, afterglow)) * 0.62
      + (1.0 - smoothstep(1.5, 2.75, afterglow)) * 0.38;
    float bloom = exp(-radius * 18.0) * (1.0 - smoothstep(0.08, 0.6, afterglow));
    float flash = exp(-radius * 105.0) * exp(-max(afterglow, 0.0) * 5.4);
    float sparks = ((spokes * sparkRing * 0.78 + fineSpokes * innerRing * 0.32) * sparkFall + bloom * 0.26 + flash * 0.70) * burstLife;

    vec3 warm = mix(vec3(1.0, 0.23, 0.09), vec3(1.0, 0.76, 0.27), step(0.5, fract(index * 0.61 + u_eventVariant)));
    vec3 cool = mix(vec3(0.26, 0.56, 1.0), vec3(0.35, 1.0, 0.66), step(0.5, fract(index * 0.43 + u_eventVariant * 1.7)));
    vec3 burstColor = mix(warm, cool, step(0.5, fract(index * 0.57 + u_eventVariant * 0.83)));
    fireworksLight += burstColor * sparks;
    fireworkGlow += shellTrail * (1.0 - smoothstep(0.78, 1.0, launch)) + shellSpark * (1.0 - smoothstep(0.82, 1.0, launch)) + bloom * burstLife;
  }
  }
  float fireworkIntensity = summerEvent * u_eventStrength;
  color += fireworksLight * fireworkIntensity * (1.0 - waterMask) * 1.28;
  color += vec3(1.0, 0.61, 0.28) * fireworkGlow * fireworkIntensity * (1.0 - waterMask) * 0.23;
  color += fireworksLight * fireworkIntensity * waterMask * 0.19;

  float sunReflection = exp(-abs(v_uv.x - sun.x) * (8.0 + depth * 17.0)) * sunVisibility;
  float moonReflection = exp(-abs(v_uv.x - moonArc.x) * (9.0 + depth * 18.0)) * moonVisibility;
  float sparkle = sin(waterPoint.x * 5.1 + waterPoint.y * 2.3 + height * 55.0 + u_time * 0.8);
  float glintNoise = fbm(waterPoint * 1.7 + vec2(ambientTime * 0.2, -ambientTime * 0.06));
  float waterActivity = clamp(0.20 + u_windStrength + gustEvent * u_eventStrength * 0.28, 0.0, 1.0);
  float glintPattern = pow(max(0.0, sparkle), 16.0) * smoothstep(0.35, 0.73, glintNoise) * smoothstep(0.02, 0.22, waterActivity);
  vec3 surfaceNormal = normalize(vec3(-slopeX * 0.9, -slopeY * 0.9, 1.0));
  vec3 viewDirection = vec3(0.0, 0.0, 1.0);
  vec3 lightDirection = normalize(vec3((sun.x - v_uv.x) * 0.75, 0.72, 0.38));
  vec3 halfDirection = normalize(viewDirection + lightDirection);
  float specular = pow(max(0.0, dot(surfaceNormal, halfDirection)), 42.0);
  float eventActivity = waterActivity;
  float reflectedSunY = 2.0 * u_horizon - sun.y;
  vec2 reflectedSunOffset = vec2((v_uv.x - sun.x + normal.x * 0.012) * aspect,
                                  topY - reflectedSunY - normal.y * 0.008);
  float reflectedSunDistance = length(reflectedSunOffset);
  float reflectedSunDisk = 1.0 - smoothstep(0.006, 0.018, reflectedSunDistance);
  float reflectedSunGlow = exp(-reflectedSunDistance * 150.0);
  float reflectedSunVisibility = sunVisibility * (1.0 - solarStrength * 0.92);
  float reflectedMoonY = 2.0 * u_horizon - moonArc.y;
  vec2 reflectedMoonOffset = vec2((v_uv.x - moonArc.x + normal.x * 0.014) * aspect,
                                   topY - reflectedMoonY - normal.y * 0.009);
  float reflectedMoonDistance = length(reflectedMoonOffset);
  float reflectedMoonDisk = 1.0 - smoothstep(0.006, 0.020, reflectedMoonDistance);
  float reflectedMoonGlow = exp(-reflectedMoonDistance * 126.0);
  float lunarReflectionTint = lunarEclipseEvent * u_eventStrength;
  vec3 warmSunReflection = mix(sunColor, vec3(0.78, 0.31, 0.20), solarStrength * 0.92);
  vec3 coolMoonReflection = mix(moonColor, vec3(0.43, 0.10, 0.055), lunarReflectionTint * 0.88);
  color += vec3(1.0, 0.66, 0.38) * sunReflection * (0.010 + glintPattern * 0.052) * waterMask;
  color += vec3(0.58, 0.75, 0.96) * moonReflection * (0.008 + glintPattern * 0.040) * waterMask;
  color += warmSunReflection * reflectedSunGlow * reflectedSunVisibility * waterMask * 0.13;
  color += warmSunReflection * reflectedSunDisk * reflectedSunVisibility * waterMask * 0.32;
  color += coolMoonReflection * reflectedMoonGlow * moonVisibility * waterMask * 0.12;
  color += coolMoonReflection * reflectedMoonDisk * moonVisibility * waterMask * 0.26;
  color += sunColor * specular * eventActivity * waterMask * sunVisibility * 0.38;
  color = mix(color, color * mix(vec3(0.68, 0.77, 0.82), vec3(1.16, 1.13, 1.08), clamp(0.5 + dot(surfaceNormal, lightDirection) * 0.65, 0.0, 1.0)), eventActivity * waterMask * 0.70);
  color = mix(color, color * vec3(0.25, 0.40, 0.62), night * waterMask * 0.64);
  float exitTorsion = exitWarp * sin(u_time * 0.6 + portalRadius * 16.0 + portalAngle * 3.0)
    * exp(-portalRadius * 5.5);
  float tunnelAngle = portalAngle + exitTorsion * 1.05;
  float tunnelRadius = max(0.0, portalRadius + exitWarp
    * sin(tunnelAngle * 2.0 + u_time * 1.1) * exp(-portalRadius * 5.0) * 0.045);
  float tunnelLightCycle = 0.5 + 0.5 * sin(u_time * 0.56 + sin(u_time * 0.23) * 0.78);
  float tunnelMistWave = sin(tunnelAngle * 2.7 + tunnelRadius * 21.0 - u_time * 0.82
    + sin(tunnelRadius * 17.0 - u_time * 0.54) * 0.68);
  float tunnelMist = 0.5 + 0.5 * tunnelMistWave;
  float mistSheet = 0.5 + 0.5 * sin(tunnelAngle * 1.55 + tunnelRadius * 9.5 - u_time * 0.42
    + sin(tunnelAngle * 2.1 + u_time * 0.17) * 0.72);
  float mistVolume = clamp(tunnelMist * 0.36 + mistSheet * 0.39 + 0.25 * tunnelLightCycle, 0.0, 1.0);
  vec3 deepFog = vec3(0.003, 0.004, 0.019);
  vec3 violetFog = vec3(0.021, 0.010, 0.073);
  vec3 blueFog = vec3(0.050, 0.075, 0.235);
  vec3 tunnelFog = mix(deepFog, violetFog, smoothstep(0.08, 0.78, mistVolume));
  tunnelFog = mix(tunnelFog, blueFog, smoothstep(0.58, 0.98, mistSheet) * 0.58);
  float tunnelExposure = mix(0.48, 1.32, tunnelLightCycle) * mix(0.76, 1.04, smoothstep(0.10, 1.45, u_portalLight));
  tunnelFog *= tunnelExposure;
  float waterRippleA = sin(tunnelRadius * 27.0 - u_time * 0.48
    + sin(tunnelAngle * 2.3 + u_time * 0.18) * 1.9);
  float waterRippleB = sin(tunnelRadius * 45.0 - u_time * 0.34
    + sin(tunnelAngle * 4.1 - u_time * 0.15) * 1.35);
  float waterRipple = (0.5 + 0.5 * waterRippleA) * 0.58 + (0.5 + 0.5 * waterRippleB) * 0.42;
  tunnelFog *= 0.58 + waterRipple * 0.74;
  tunnelFog += vec3(0.004, 0.009, 0.038) * waterRipple * (0.36 + tunnelLightCycle * 0.88);
  float causticPhase = sin(tunnelRadius * 74.0 - u_time * 1.35
    + sin(tunnelAngle * 3.2 + u_time * 0.26) * 4.2)
    * sin(tunnelAngle * 6.0 + tunnelRadius * 26.0 - u_time * 0.73);
  float waterCaustic = pow(max(0.0, causticPhase), 5.0);
  tunnelFog += vec3(0.024, 0.070, 0.22) * waterCaustic * (0.08 + tunnelLightCycle * 0.28);
  float tunnelGlow = exp(-tunnelRadius * 4.2) * (0.28 + 0.72 * tunnelLightCycle)
    * (0.35 + 0.65 * (0.5 + 0.5 * sin(tunnelAngle * 3.6 - u_time * 1.05)));
  tunnelFog += vec3(0.012, 0.024, 0.098) * tunnelGlow;
  float sceneAbsorb = smoothstep(0.36, 0.64, u_portalProgress);
  color = mix(color, tunnelFog, sceneAbsorb);
  float portalStrength = smoothstep(0.0, 0.08, u_portalProgress);
  float horizonRadius = mix(0.018, 0.24, smoothstep(0.0, 1.0, u_portalProgress));
  float eventHorizon = 1.0 - smoothstep(horizonRadius - 0.025, horizonRadius + 0.045, portalRadius);
  vec3 portalShadow = color * vec3(0.10, 0.075, 0.23) + vec3(0.002, 0.003, 0.012);
  color = mix(color, portalShadow, eventHorizon * portalStrength * 0.94);
  float accretionRadius = 0.36 - u_portalProgress * 0.16
    + sin(portalAngle * 3.0 - u_portalProgress * 17.0 + u_time * 0.42) * 0.035;
  float accretionBand = exp(-abs(portalRadius - accretionRadius) * 33.0);
  float flowNoise = sin(portalAngle * 4.2 + portalRadius * 38.0 - u_portalProgress * 31.0
    - u_time * (0.42 + u_portalLight * 0.34)
    + sin(portalRadius * 27.0 - u_portalProgress * 13.0 + u_time * 0.76) * 0.8);
  float flowingLight = smoothstep(-0.18, 0.92, flowNoise);
  float luminousFilament = pow(max(0.0, flowingLight), 8.0) * accretionBand * portalStrength;
  float portalLight = clamp(u_portalLight, 0.0, 2.0) * portalStrength;
  vec3 coolGlow = mix(vec3(0.18, 0.11, 0.48), vec3(0.24, 0.56, 1.0),
    smoothstep(0.45, 1.65, u_portalLight));
  vec3 whiteCore = mix(vec3(0.36, 0.34, 0.88), vec3(0.86, 0.93, 1.0),
    smoothstep(0.55, 1.75, u_portalLight));
  color += coolGlow * accretionBand * (0.18 + flowingLight * 0.72) * portalLight * 0.30;
  color += whiteCore * luminousFilament * portalLight * 0.56;
  float horizonRim = exp(-abs(portalRadius - horizonRadius) * 58.0) * portalStrength;
  color += mix(vec3(0.20, 0.13, 0.52), vec3(0.42, 0.68, 1.0), smoothstep(0.4, 1.6, u_portalLight))
    * horizonRim * (0.16 + portalLight * 0.36);
  color = mix(color, color * vec3(0.22, 0.18, 0.37) + vec3(0.004, 0.004, 0.020),
    u_portalProgress * (1.0 - smoothstep(0.05, 0.95, u_portalLight)) * 0.48);
  float darkFlow = 1.0 - smoothstep(0.13, 0.66, u_portalLight);
  float tunnelPulse = sin(portalAngle * 2.2 + portalRadius * 32.0 - u_time * 1.4
    + sin(portalRadius * 18.0 + u_time * 0.62) * 0.75);
  vec3 tunnelTint = mix(vec3(0.008, 0.004, 0.030), vec3(0.072, 0.046, 0.190),
    smoothstep(-0.25, 0.82, tunnelPulse));
  vec3 tunnelThreads = vec3(0.0);
  vec3 waterStreams = vec3(0.0);
  float tunnelFilament = 0.0;
  float tunnelThreadVisibility = 0.38 + darkFlow * 0.34 + tunnelLightCycle * 0.28;
  float pathConvergence = 1.0 - smoothstep(0.58, 0.98, u_portalProgress);
  float streamVisibility = portalStrength * (0.24 + smoothstep(0.15, 1.35, portalLight) * 0.34 + tunnelLightCycle * 0.24);
  float debrisVisibility = portalStrength * smoothstep(0.18, 0.34, u_portalProgress)
    * mix(0.46, 1.0, 1.0 - smoothstep(0.62, 0.94, u_portalProgress));
  if (portalStrength > 0.001) {
    for (int i = 0; i < 4; i++) {
      float layer = float(i);
      float bend = sin(tunnelAngle * (1.05 + layer * 0.57) + u_time * (0.16 + layer * 0.08)
        + sin(tunnelAngle * (2.1 + layer * 0.22) - u_time * 0.21 + layer * 1.4) * 0.72);
      float layerRadius = accretionRadius + (layer - 1.5) * 0.046 * pathConvergence
        + bend * (0.015 + layer * 0.004) * pathConvergence;
      float lineBand = exp(-abs(tunnelRadius - layerRadius) * (156.0 + layer * 16.0));
      float threadPhase = tunnelAngle * (7.0 + layer * 2.0) + tunnelRadius * (96.0 + layer * 20.0)
        - u_time * (0.34 + layer * 0.11)
        + sin(tunnelAngle * (2.0 + layer * 0.32) + u_time * 0.24) * 0.62
        + (waterRipple - 0.5) * (0.70 + layer * 0.18);
      float fineStrands = pow(max(0.0, 0.5 + 0.5 * sin(threadPhase)), 7.0);
      vec3 layerTint = mix(vec3(0.020, 0.015, 0.064), tunnelTint, 0.18 + layer * 0.08);
      tunnelThreads += layerTint * lineBand * (0.045 + fineStrands * 0.24);
      tunnelFilament += lineBand * fineStrands / 4.0;

      float streamPhase = tunnelAngle * (2.0 + layer * 0.34) + tunnelRadius * (19.0 + layer * 2.4)
        - u_time * (0.76 + layer * 0.16)
        + sin(tunnelAngle * (3.0 + layer * 0.2) - u_time * 0.24) * (0.34 + layer * 0.04)
        + (waterRipple - 0.5) * 0.62;
      float streamBody = 1.0 - smoothstep(0.02, 0.24, abs(sin(streamPhase)));
      float foamGlint = pow(max(0.0, 0.5 + 0.5 * sin(streamPhase * 4.2 - u_time * 1.8 + layer)), 6.0);
      vec3 streamTint = mix(vec3(0.028, 0.024, 0.13), vec3(0.30, 0.61, 0.98),
        clamp(foamGlint * 0.82 + waterRipple * 0.18, 0.0, 1.0));
      float streamExposure = mix(0.42, 1.28, tunnelLightCycle) * (0.72 + foamGlint * 0.28);
      waterStreams += streamTint * streamBody * (0.13 + foamGlint * 0.42) * streamExposure * 0.25;
    }

    for (int i = 0; i < 12; i++) {
      float seed = float(i) + 0.5;
      float kind = hash21(vec2(seed, 17.4));
      float fastLayer = hash21(vec2(seed, 3.7));
      float depthBand = hash21(vec2(seed, 12.1));
      float travel = fract(seed * 0.618 + u_portalTime * mix(0.010, 0.095, fastLayer)
        + u_portalProgress * mix(0.045, 0.12, fastLayer));
      float outerRadius = mix(0.54, 1.04, depthBand);
      float innerRadius = mix(0.035, 0.145, depthBand);
      float objectRadius = mix(outerRadius, innerRadius, travel);
      float direction = hash21(vec2(seed, 5.5)) > 0.5 ? 1.0 : -1.0;
      float orbitAngle = seed * 2.399 + u_portalTime * direction * mix(0.07, 0.46, fastLayer)
        + u_portalProgress * mix(1.4, 4.2, fastLayer)
        + sin(u_portalTime * (0.19 + fastLayer * 0.44) + seed) * (0.18 + fastLayer * 0.22);
      float isLeaf = step(0.68, kind);
      float isSoil = 1.0 - step(0.28, kind);
      float isStone = 1.0 - isLeaf - isSoil;
      float spinRate = mix(0.08, 0.34, fastLayer) + isLeaf * (0.42 + fastLayer * 0.74);
      float objectFlutter = isLeaf * sin(u_portalTime * (0.42 + fastLayer * 1.25) + seed * 2.3)
        * (0.010 + fastLayer * 0.012) * (0.55 + objectRadius);
      vec2 objectCenter = vec2(cos(orbitAngle), sin(orbitAngle)) * objectRadius
        + vec2(sin(orbitAngle * 1.7 + u_portalTime * 0.38), cos(orbitAngle * 1.3 - u_portalTime * 0.29)) * objectFlutter;
      vec2 objectDelta = portalSpace - objectCenter;
      float objectRotation = seed * 2.17 + u_portalTime * spinRate * direction + u_portalProgress * 0.62;
      vec2 objectPoint = mat2(cos(objectRotation), -sin(objectRotation),
        sin(objectRotation), cos(objectRotation)) * objectDelta;
      float depthScale = mix(0.40, 1.22, depthBand) * mix(0.72, 1.0, objectRadius);
      float objectLength = (0.022 + hash21(vec2(seed, 1.1)) * 0.036) * depthScale;
      float objectWidth = (0.013 + hash21(vec2(seed, 8.6)) * 0.023) * depthScale;
      float alongObject = objectPoint.y / objectLength;
      float acrossObject = objectPoint.x / objectWidth;
      float rockCorner = max(abs(acrossObject), abs(alongObject))
        + min(abs(acrossObject), abs(alongObject)) * 0.22
        + sin((acrossObject + alongObject) * 5.3 + seed) * 0.065;
      float edgeSoftness = mix(0.10, 0.30, 1.0 - depthBand);
      float stoneMask = 1.0 - smoothstep(0.82 - edgeSoftness * 0.42, 1.12 + edgeSoftness * 0.42, rockCorner);
      float soilGrain = 0.5 + 0.5 * sin(objectPoint.x * 270.0 + objectPoint.y * 185.0 + seed * 7.0);
      float soilShape = length(vec2(acrossObject * 0.84, alongObject * 1.12))
        + sin((acrossObject - alongObject) * 4.2 + seed) * 0.10;
      float soilMask = 1.0 - smoothstep(0.77 - edgeSoftness * 0.42, 1.15 + edgeSoftness * 0.42, soilShape);
      float leafAlong = objectPoint.y / (objectLength * 0.92);
      float leafProfile = max(0.07, 1.0 - abs(leafAlong));
      float leafShape = max(abs(acrossObject) / (leafProfile * 1.22), abs(leafAlong));
      float leafMask = 1.0 - smoothstep(0.84 - edgeSoftness * 0.36, 1.04 + edgeSoftness * 0.36, leafShape);
      float cycleFade = smoothstep(0.0, 0.018, travel) * (1.0 - smoothstep(0.988, 1.0, travel));
      float depthFade = smoothstep(innerRadius, innerRadius + mix(0.055, 0.12, depthBand), objectRadius);
      float sideLight = 0.28 + 0.72 * max(0.0, cos(orbitAngle + u_time * 0.11 + objectRotation * 0.22));
      float facet = clamp(0.50 + acrossObject * 0.20 - alongObject * 0.14
        + sin(seed * 4.0 + objectRotation) * 0.12, 0.12, 0.94);
      vec3 stoneBase = mix(vec3(0.035, 0.030, 0.062), vec3(0.15, 0.105, 0.078), kind);
      vec3 stoneFace = mix(vec3(0.19, 0.205, 0.29), vec3(0.48, 0.35, 0.24), kind);
      vec3 stoneColor = mix(stoneBase, stoneFace, facet) * (0.48 + sideLight * 0.72);
      vec3 soilColor = mix(vec3(0.050, 0.029, 0.025), vec3(0.27, 0.15, 0.075), soilGrain)
        * (0.52 + sideLight * 0.52);
      vec3 leafBase = mix(vec3(0.72, 0.38, 0.075), vec3(0.25, 0.39, 0.11), hash21(vec2(seed, 9.2)));
      float leafVein = exp(-abs(objectPoint.x) * 280.0) * (1.0 - smoothstep(0.64, 0.98, abs(leafAlong)));
      vec3 leafColor = leafBase * (0.43 + sideLight * 0.76) + vec3(0.18, 0.12, 0.035) * leafVein * 0.34;
      vec3 objectColor = stoneColor * isStone + soilColor * isSoil + leafColor * isLeaf;
      float objectMask = stoneMask * isStone + soilMask * isSoil + leafMask * isLeaf;
      objectColor *= mix(0.48, 1.20, tunnelLightCycle) * mix(0.42, 1.0, depthBand);
      float objectAlpha = objectMask * cycleFade * depthFade * debrisVisibility;
      color = mix(color, objectColor, objectAlpha);
      float objectRim = smoothstep(0.38, 0.72, objectMask) * (1.0 - smoothstep(0.86, 0.99, objectMask));
      color += vec3(0.055, 0.16, 0.39) * objectRim * objectAlpha * (0.22 + waterRipple * 0.30);
    }

    vec2 dustDrift = portalSpace + vec2(u_time * 0.035, -u_time * 0.062);
    float farDust = step(0.994, hash21(floor(dustDrift * 78.0)));
    float nearDust = step(0.991, hash21(floor(dustDrift * 43.0 + 17.0)));
    color += vec3(0.10, 0.09, 0.16) * (farDust * 0.018 + nearDust * 0.032)
      * portalStrength * (0.36 + tunnelLightCycle * 0.92);
  }
  color += tunnelThreads * portalStrength * tunnelThreadVisibility * 0.78;
  color += waterStreams * streamVisibility;
  color += vec3(0.012, 0.018, 0.072) * exp(-portalRadius * 6.2) * portalStrength * darkFlow
    * (0.36 + clamp(tunnelFilament, 0.0, 1.0) * 0.38);
  color = pow(max(color, vec3(0.0)), vec3(0.94));
  gl_FragColor = vec4(color, 1.0);
}`;

export default function WaterScene({ subject, loginMode = false, portalProgressRef, portalLightRef }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const [creaturePass, setCreaturePass] = useState(null);
  const weatherEventRef = useRef(null);
  const weatherCloudCoverRef = useRef(0);
  const portalProgressInputRef = useRef(portalProgressRef);
  const portalLightInputRef = useRef(portalLightRef);
  const scene = scenes[subject] || scenes.torii;
  portalProgressInputRef.current = portalProgressRef;
  portalLightInputRef.current = portalLightRef;

  useEffect(() => {
    let active = true;
    async function refreshWeather() {
      try {
        const response = await fetch("/login/weather");
        if (!response.ok) return;
        const result = await response.json();
        const id = result?.weatherEvent;
        const cloudCover = result?.cloudCover;
        if (active) {
          weatherEventRef.current = [2, 3, 6, 13].includes(id) ? id : null;
          weatherCloudCoverRef.current = typeof cloudCover === "number" && Number.isFinite(cloudCover)
            ? Math.max(0, Math.min(1, cloudCover))
            : 0;
        }
      } catch {
        if (active) {
          weatherEventRef.current = null;
          weatherCloudCoverRef.current = 0;
        }
      }
    }
    refreshWeather();
    const interval = window.setInterval(refreshWeather, 15 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
    if (!stage || !canvas || !gl) return;

    function compile(type, source) {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    const moonTexture = gl.createTexture();
    const japanTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, japanTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, moonTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const uniforms = {
      photo: gl.getUniformLocation(program, "u_photo"),
      moonMap: gl.getUniformLocation(program, "u_moonMap"),
      japan: gl.getUniformLocation(program, "u_japan"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      photoSize: gl.getUniformLocation(program, "u_photoSize"),
      japanSize: gl.getUniformLocation(program, "u_japanSize"),
      time: gl.getUniformLocation(program, "u_time"),
      portalTime: gl.getUniformLocation(program, "u_portalTime"),
      progress: gl.getUniformLocation(program, "u_progress"),
      portalLight: gl.getUniformLocation(program, "u_portalLight"),
      horizon: gl.getUniformLocation(program, "u_horizon"),
      guardTorii: gl.getUniformLocation(program, "u_guardTorii"),
      windStrength: gl.getUniformLocation(program, "u_windStrength"),
      windDirection: gl.getUniformLocation(program, "u_windDirection"),
      waveStrength: gl.getUniformLocation(program, "u_waveStrength"),
      ripples: gl.getUniformLocation(program, "u_ripples[0]"),
      reducedMotion: gl.getUniformLocation(program, "u_reducedMotion"),
      japanBlend: gl.getUniformLocation(program, "u_japanBlend"),
      event: gl.getUniformLocation(program, "u_event"),
      eventStrength: gl.getUniformLocation(program, "u_eventStrength"),
      eventTime: gl.getUniformLocation(program, "u_eventTime"),
      eventDuration: gl.getUniformLocation(program, "u_eventDuration"),
      eventCycleTime: gl.getUniformLocation(program, "u_eventCycleTime"),
      eventCycleDuration: gl.getUniformLocation(program, "u_eventCycleDuration"),
      eventDirection: gl.getUniformLocation(program, "u_eventDirection"),
      eventVariant: gl.getUniformLocation(program, "u_eventVariant"),
      weatherCloudCover: gl.getUniformLocation(program, "u_weatherCloudCover"),
      portalProgress: gl.getUniformLocation(program, "u_portalProgress"),
    };
    const image = new Image();
    const moonMap = new Image();
    const japan = new Image();
    image.decoding = "async";
    moonMap.decoding = "async";
    japan.decoding = "async";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startedAt = performance.now();
    let frame = 0;
    let photoReady = false;
    let moonMapReady = false;
    let japanReady = false;
    let imageReady = false;
    let inView = true;
    let pageVisible = !document.hidden;
    let disposed = false;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let waveCalmUntil = -Infinity;
    const pointerRipples = new Float32Array(16);
    let nextPointerRipple = 0;
    let lastPointerRippleAt = -Infinity;
    let lastPointerPosition = null;
    let gust = { startedAt: 0, strength: 0, direction: [1, 0.18] };
    let lastGustAt = -Infinity;
    let lastScrollY = window.scrollY;
    let activeEvent = { id: 0, startedAt: -Infinity, duration: 0, cycleDuration: 1, weatherControlled: false };
    let lastEventAt = -Infinity;
    let nextEventAt = 8 + Math.random() * 6;
    let portalStartedAt = null;

    function canDraw() {
      return !disposed && inView && pageVisible;
    }

    function scheduleDraw() {
      if (!frame && canDraw()) frame = requestAnimationFrame(draw);
    }

    function resizeCanvas() {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.0);
      const width = Math.max(1, Math.round(stage.clientWidth * ratio));
      const height = Math.max(1, Math.round(stage.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height || canvasWidth !== width || canvasHeight !== height) {
        canvas.width = width;
        canvas.height = height;
        canvasWidth = width;
        canvasHeight = height;
        gl.viewport(0, 0, width, height);
      }
      scheduleDraw();
    }

    function updateImageReady() {
      imageReady = photoReady && moonMapReady && japanReady;
      if (imageReady) scheduleDraw();
    }

    function onVisibilityChange() {
      pageVisible = !document.hidden;
      if (pageVisible) scheduleDraw();
      else if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }

    const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) scheduleDraw();
      else if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }, { rootMargin: "120px" });
    intersectionObserver?.observe(stage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", resizeCanvas, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeCanvas);
    resizeObserver?.observe(stage);
    resizeCanvas();

    function startEvent(selected, now, level = 1 + Math.floor(Math.random() * 3)) {
      const elapsed = (now - startedAt) / 1000;
      const duration = selected.duration;
      const cycleDuration = eventCycles[selected.id] || duration;
      const direction = Math.random() < 0.5 ? -1 : 1;
      const variant = Math.random();
      activeEvent = { id: selected.id, startedAt: elapsed, duration, cycleDuration, direction, level, variant, weatherControlled: Boolean(selected.weatherControlled) };
      lastEventAt = now;
      nextEventAt = elapsed + activeEvent.duration + 6 + Math.random() * 6;
      setCreaturePass([16, 18, 27].includes(selected.id)
        ? { id: selected.id, startedAt: now, duration, cycleDuration, variant, direction, level }
        : null);

      if ([6, 16, 18, 27].includes(selected.id)) {
        const angle = (Math.random() - 0.5) * 0.56;
        gust = {
          startedAt: now,
          strength: selected.id === 27 ? 0.95 : selected.id === 6 ? 0.58 : 0.26 + Math.random() * 0.12,
          direction: [Math.cos(angle), Math.sin(angle)],
        };
      }
    }

    function startRandomEvent(progress, now) {
      const period = periodAt(progress);
      const available = randomEvents.filter((event) => event.periods.includes(period));
      const weightTotal = available.reduce((sum, event) => sum + event.weight, 0);
      let roll = Math.random() * weightTotal;
      const selected = available.find((event) => (roll -= event.weight) <= 0) || available[0];
      startEvent(selected, now);
    }

    function triggerWind() {
      const now = performance.now();
      if (now - lastGustAt < 520) return;
      lastGustAt = now;
      const angle = (Math.random() - 0.5) * 0.72;
      gust = {
        startedAt: now,
        strength: 0.32 + Math.random() * 0.16,
        direction: [Math.cos(angle), Math.sin(angle)],
      };
    }

    function draw(now) {
      frame = 0;
      if (!canDraw() || !imageReady) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniforms.photo, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, moonTexture);
      gl.uniform1i(uniforms.moonMap, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, japanTexture);
      gl.uniform1i(uniforms.japan, 2);
      gl.uniform2f(uniforms.resolution, canvasWidth, canvasHeight);
      gl.uniform2f(uniforms.photoSize, image.naturalWidth, image.naturalHeight);
      gl.uniform2f(uniforms.japanSize, japan.naturalWidth || 1, japan.naturalHeight || 1);
      const elapsed = (now - startedAt) / 1000;
      const scrollRange = document.documentElement.scrollHeight - window.innerHeight;
      const localClock = new Date();
      const localSeconds = localClock.getHours() * 3600 + localClock.getMinutes() * 60 + localClock.getSeconds();
      const baseProgress = loginMode
        ? localSeconds / 86400
        : scrollRange > 0 ? Math.max(0, Math.min(1, window.scrollY / scrollRange)) : 0;
      const selectedWeather = weatherEvents.find((event) => event.id === weatherEventRef.current);
      if (selectedWeather) {
        const weatherEventAge = elapsed - activeEvent.startedAt;
        if (!activeEvent.weatherControlled || activeEvent.id !== selectedWeather.id || weatherEventAge >= activeEvent.duration) {
          startEvent(selectedWeather, now, selectedWeather.id === 6 ? 3 : 2);
        }
      } else if (activeEvent.weatherControlled) {
        activeEvent = { id: 0, startedAt: -Infinity, duration: 0, cycleDuration: 1, weatherControlled: false };
        setCreaturePass(null);
        nextEventAt = elapsed + 5;
      }
      if (!selectedWeather && elapsed >= nextEventAt && elapsed - activeEvent.startedAt >= activeEvent.duration) startRandomEvent(baseProgress, now);
      const eventAge = activeEvent.id ? Math.max(0, elapsed - activeEvent.startedAt) : 0;
      const easeInOut = (value) => {
        const t = Math.max(0, Math.min(1, value));
        return t * t * (3 - 2 * t);
      };
      const eventStrength = activeEvent.id && eventAge >= 0 && eventAge < activeEvent.duration
        ? Math.min(easeInOut(eventAge / 28), easeInOut((activeEvent.duration - eventAge) / 42)) * ((activeEvent.level || 1) / 3)
        : 0;
      gl.uniform1f(uniforms.time, elapsed);
      gl.uniform1f(uniforms.progress, baseProgress);
      const portalProgress = Math.min(1, Math.max(0, portalProgressInputRef.current?.current || 0));
      if (portalProgress > 0 && portalStartedAt === null) portalStartedAt = elapsed;
      else if (portalProgress === 0) portalStartedAt = null;
      const portalTime = portalStartedAt === null ? 0 : elapsed - portalStartedAt;
      gl.uniform1f(uniforms.portalTime, portalTime);
      gl.uniform1f(uniforms.portalProgress, portalProgress);
      const portalLight = Math.min(2, Math.max(0, portalLightInputRef.current?.current || 0));
      gl.uniform1f(uniforms.portalLight, portalLight);
      gl.uniform1f(uniforms.horizon, scene.horizon);
      gl.uniform1f(uniforms.guardTorii, subject === "torii" ? 1 : 0);
      gl.uniform1f(uniforms.reducedMotion, reducedMotion ? 1 : 0);
      gl.uniform1f(uniforms.japanBlend, subject === "torii" ? 1 : 0);
      gl.uniform1f(uniforms.event, eventStrength > 0 ? activeEvent.id : 0);
      gl.uniform1f(uniforms.eventStrength, eventStrength);
      gl.uniform1f(uniforms.eventTime, Math.min(eventAge, activeEvent.duration || 0));
      gl.uniform1f(uniforms.eventDuration, activeEvent.duration || 1);
      gl.uniform1f(uniforms.eventCycleTime, eventAge % Math.max(activeEvent.cycleDuration || 1, 0.1));
      gl.uniform1f(uniforms.eventCycleDuration, activeEvent.cycleDuration || 1);
      gl.uniform1f(uniforms.eventDirection, activeEvent.direction || 1);
      gl.uniform1f(uniforms.eventVariant, activeEvent.variant || 0);
      gl.uniform1f(uniforms.weatherCloudCover, weatherCloudCoverRef.current);
      const gustAge = (now - gust.startedAt) / 1000;
      const gustBuild = easeInOut(gustAge / 5);
      const gustRelease = 1 - easeInOut((gustAge - 12) / 16);
      const gustEnvelope = gustAge >= 0 && gustAge < 28 ? gustBuild * gustRelease * gust.strength : 0;
      const weatherEvent = [2, 3, 6, 13].includes(activeEvent.id);
      const weatherBuild = easeInOut(eventAge / 72);
      const weatherRelease = 1 - easeInOut((eventAge - (activeEvent.duration - 64)) / 44);
      const weatherPeak = activeEvent.id === 6 ? 0.78 : 0.42;
      const weatherWind = weatherEvent ? eventStrength * (0.13 + weatherPeak * weatherBuild) * weatherRelease : 0;
      const breezePulse = 0.18 + 0.30 * (0.5 + 0.5 * Math.sin(eventAge * 0.045));
      const ambientWind = 0;
      const seasonalBuild = easeInOut(eventAge / 18);
      const seasonalRelease = 1 - easeInOut((eventAge - (activeEvent.duration - 55)) / 38);
      const seasonalWind = [16, 18].includes(activeEvent.id) ? eventStrength * 0.26 * seasonalBuild * seasonalRelease : 0;
      const leafWind = activeEvent.id === 27 ? eventStrength * 0.82 * seasonalBuild * seasonalRelease : 0;
      gl.uniform1f(uniforms.windStrength, Math.max(gustEnvelope, weatherWind, ambientWind, seasonalWind, leafWind));
      gl.uniform2f(uniforms.windDirection, gust.direction[0], gust.direction[1]);
      const pointerCalm = Math.exp(-Math.max(0, now - waveCalmUntil) / 1200);
      gl.uniform1f(uniforms.waveStrength, 1.0 - pointerCalm * 0.68);
      gl.uniform4fv(uniforms.ripples, pointerRipples);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      scheduleDraw();
    }

    function pointerOnWater(event) {
      const rect = stage.getBoundingClientRect();
      const y = (event.clientY - rect.top) / rect.height;
      if (y < scene.horizon || y > 1.0) return null;
      const x = (event.clientX - rect.left) / rect.width;
      const depth = (y - scene.horizon) / (1.0 - scene.horizon);
      if (depth < 0.045) return null;
      const distance = 1.0 / depth;
      const aspect = rect.width / Math.max(rect.height, 1);
      return { x: (x - 0.5) * aspect * distance * 1.6, y: distance };
    }

    function addPointerRipple(point, now, strength) {
      const slot = nextPointerRipple * 4;
      pointerRipples[slot] = point.x;
      pointerRipples[slot + 1] = point.y;
      pointerRipples[slot + 2] = (now - startedAt) / 1000;
      pointerRipples[slot + 3] = strength;
      nextPointerRipple = (nextPointerRipple + 1) % 4;
    }

    function onPointerDown(event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const point = pointerOnWater(event);
      if (!point) return;
      const now = performance.now();
      waveCalmUntil = now + 280;
      addPointerRipple(point, now, 1.65);
      lastPointerRippleAt = now;
      lastPointerPosition = { x: event.clientX, y: event.clientY };
    }

    function onPointerMove(event) {
      if (event.pointerType === "touch" ? event.buttons === 0 : event.pointerType !== "mouse") return;
      const point = pointerOnWater(event);
      if (!point) return;
      const now = performance.now();
      const movedEnough = !lastPointerPosition || Math.hypot(event.clientX - lastPointerPosition.x, event.clientY - lastPointerPosition.y) >= 12;
      if (now - lastPointerRippleAt < 110 || !movedEnough) return;
      waveCalmUntil = now + 280;
      addPointerRipple(point, now, event.pointerType === "mouse" ? 1.0 : 1.25);
      lastPointerRippleAt = now;
      lastPointerPosition = { x: event.clientX, y: event.clientY };
    }

    function onScrollGesture(event) {
      if (event.target instanceof Element && event.target.closest(".editor")) return;
      triggerWind();
    }

    function onPageScroll() {
      const nextY = window.scrollY;
      if (Math.abs(nextY - lastScrollY) > 52) {
        triggerWind();
        const now = performance.now();
        const elapsed = (now - startedAt) / 1000;
        if (elapsed - activeEvent.startedAt >= activeEvent.duration && now - lastEventAt > 6500 && Math.random() < 0.38) {
          const scrollRange = document.documentElement.scrollHeight - window.innerHeight;
          const progress = scrollRange > 0 ? Math.max(0, Math.min(1, nextY / scrollRange)) : 0;
          startRandomEvent(progress, now);
        }
      }
      lastScrollY = nextY;
    }

    image.onload = () => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      photoReady = true;
      updateImageReady();
    };
    image.onerror = () => console.error("Unable to load scene photo:", scene.src);
    image.src = scene.src;
    moonMap.onload = () => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, moonTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, moonMap);
      moonMapReady = true;
      updateImageReady();
    };
    moonMap.onerror = () => {
      console.error("Unable to load lunar surface map");
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, moonTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([170, 170, 174, 255]));
      moonMapReady = true;
      updateImageReady();
    };
    moonMap.src = "/login/moon-map.jpg";
    if (subject === "torii") {
      japan.onload = () => {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, japanTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, japan);
        japanReady = true;
        updateImageReady();
      };
      japan.onerror = () => {
        console.error("Unable to load Japanese mountain photo");
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, japanTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([80, 92, 110, 255]));
        japanReady = true;
        updateImageReady();
      };
      japan.src = "/login/japan-mountains.jpg";
    } else {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, japanTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([80, 92, 110, 255]));
      japanReady = true;
      updateImageReady();
    }
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("wheel", onScrollGesture, { passive: true });
    window.addEventListener("touchmove", onScrollGesture, { passive: true });
    window.addEventListener("scroll", onPageScroll, { passive: true });
    scheduleDraw();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      intersectionObserver?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", resizeCanvas);
      image.onload = null;
      image.onerror = null;
      moonMap.onload = null;
      moonMap.onerror = null;
      japan.onload = null;
      japan.onerror = null;
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("wheel", onScrollGesture);
      window.removeEventListener("touchmove", onScrollGesture);
      window.removeEventListener("scroll", onPageScroll);
      gl.deleteTexture(texture);
      gl.deleteTexture(moonTexture);
      gl.deleteTexture(japanTexture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [scene, loginMode]);

  return (
    <div className="stage" ref={stageRef}>
      <canvas ref={canvasRef} className="water-canvas" style={{ backgroundImage: `url("${scene.src}")` }} aria-hidden="true" />
      {creaturePass && <SceneWildlife horizon={scene.horizon} subject={subject} pass={creaturePass} />}
      <div className="photo-shade" aria-hidden="true" />
    </div>
  );
}
