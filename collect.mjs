#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 예측 정확도 백테스트 — 관측 스냅샷 수집기
//
// "우리 예측이 실제로 몇 % 맞았나"에 답하려면 예측과 그 이후의 실측이 같은
// 시간축 위에 있어야 한다. 이 스크립트는 /api/live 를 호출해 각 지점의
// 예측(추세·ETA·공급자 예보)과 관측(혼잡 등급·밀도·인원)을 한 줄로 적재한다.
//
// 사용:
//   node collect.mjs                          # 배포본에서 수집
//   BASE=http://localhost:3000 node collect.mjs
//   OUT=backtest node collect.mjs
//
// 저장 형식: backtest/YYYY-MM-DD.jsonl (한 줄 = 한 시점 32지점 스냅샷)
// 원본 갱신 주기(5분)보다 자주 호출해도 같은 관측이 반복되므로, 직전 줄과
// 관측 시각이 같으면 기록하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE ?? "https://crowdsense-jvv1.vercel.app";
const OUT_DIR = process.env.OUT ?? "backtest";
const PROVIDER = process.env.PROVIDER ?? "";

/** 공급자 표준시(KST) 기준 날짜 — 파일을 하루 단위로 나눈다 */
function dateKey(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** 마지막 줄의 관측 시각 — 중복 적재 방지 */
function lastObservedAt(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last).observedAtMs ?? null;
  } catch {
    return null;
  }
}

function compact(scenario) {
  const zones = scenario.zones.map((z) => {
    const s = z.signals ?? {};
    const f = s.inflowForecast ?? null;
    return {
      name: z.name,
      // ── 관측 ──
      obsMs: s.observedAtMs ?? null,
      congest: s.congestLabel ?? null,
      density: z.density,
      level: z.level,
      grade: z.grade,
      popMin: s.populationMin ?? null,
      popMax: s.populationMax ?? null,
      // ── 우리 예측 ──
      trend: f?.trend ?? null,
      baseWindow: f?.baseWindowMinutes ?? null,
      netLo: f?.netPerMinRange?.[0] ?? null,
      netHi: f?.netPerMinRange?.[1] ?? null,
      surge: f?.surgeRatio ?? null,
      densityRate: f?.densityRatePerMin ?? null,
      etaMin: f?.etaMinutes ?? null,
      dataAge: f?.dataAgeMinutes ?? null,
      // ── 공급자 예측 (선행 시간 비교 기준선) ──
      // 상승 사건 소급 탐색이 최대 120분이므로 4시간치면 충분하다.
      // 12시간 곡선을 전부 적재하면 스냅샷 용량의 절반을 예보가 차지한다.
      fcst: (z.liveForecasts ?? []).slice(0, 4).map((x) => ({
        t: x.time,
        c: x.congest,
        w: x.worse,
      })),
    };
  });

  // 시나리오 기준 관측 시각은 '가장 오래된 관측'이므로, 스냅샷 식별에는
  // 지점별 관측 시각의 최빈값(사실상 전 지점 동일)을 쓴다.
  const obsList = zones.map((z) => z.obsMs).filter((v) => v != null);
  const observedAtMs = obsList.length
    ? obsList.sort((a, b) => a - b)[Math.floor(obsList.length / 2)]
    : null;

  return {
    collectedAt: Date.now(),
    observedAtMs,
    updatedAt: scenario.updatedAt ?? null,
    provider: scenario.provider?.id ?? null,
    expected: scenario.expectedZoneCount ?? zones.length,
    received: zones.length,
    degraded: (scenario.degraded ?? []).map((d) => d.areaName),
    stale: Boolean(scenario.stale),
    zones,
  };
}

const url = `${BASE}/api/live${PROVIDER ? `?provider=${encodeURIComponent(PROVIDER)}` : ""}`;
const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
if (!res.ok) {
  console.error(`수집 실패: HTTP ${res.status} ${url}`);
  process.exit(1);
}
const scenario = await res.json();
if (scenario.error) {
  console.error(`수집 실패: ${scenario.error}`);
  process.exit(1);
}

const row = compact(scenario);
if (row.observedAtMs == null) {
  console.error("관측 시각이 없어 적재하지 않습니다.");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `${dateKey(row.observedAtMs)}.jsonl`);

if (lastObservedAt(file) === row.observedAtMs) {
  console.log(`중복 관측(${row.updatedAt}) — 적재 생략`);
  process.exit(0);
}

appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
const trends = row.zones.reduce((m, z) => {
  m[z.trend ?? "-"] = (m[z.trend ?? "-"] ?? 0) + 1;
  return m;
}, {});
console.log(
  `적재 ${file} · 관측 ${row.updatedAt} · ${row.received}/${row.expected}지점 · ` +
    Object.entries(trends)
      .map(([k, v]) => `${k} ${v}`)
      .join(" / "),
);
