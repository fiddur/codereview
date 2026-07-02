// Posts 7 days of synthetic Health Connect-style data to the local Aurboda
// the way the Android app does. Read token from the local-storage blob saved
// by 01-signup.mjs (we wrote that into a file there) or pass via env.
import { readFile } from 'node:fs/promises'

const API = 'http://localhost:8080/api'
let token = process.env.AURBODA_TOKEN
if (!token) {
  // Re-login to get a fresh token (login is cheap, beats parsing localstorage).
  const r = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'qsreddit_demo', password: 'demopassword123!' }),
  })
  const j = await r.json()
  token = j.token
  if (!token) throw new Error(`Login failed: ${JSON.stringify(j)}`)
}
console.log('token len', token.length)

const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const text = await r.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (!r.ok) console.log(`  ✗ ${path} ${r.status}`, parsed)
  else console.log(`  ✓ ${path}`, parsed)
  return parsed
}

// Anchor to "yesterday 22:00 local" so today has just morning data.
const TZ_OFFSET_MIN = new Date().getTimezoneOffset()
const now = new Date()
const days = 7
const idCounter = (() => { let i = 0; return () => `seed-${Date.now()}-${++i}` })()

const isoFromLocal = (d) => d.toISOString()

// --- Build records day by day ---
const sleepRecords = []
const restingHrRecords = []
const hrvRecords = []
const weightRecords = []
const exerciseRecords = []
const hrSampleRecords = []      // HeartRateRecord with samples
const stepsDailyAggs = []
const activeCaloriesDailyAggs = []
const totalCaloriesDailyAggs = []

for (let d = days; d >= 0; d--) {
  const day = new Date(now)
  day.setDate(day.getDate() - d)
  day.setHours(0, 0, 0, 0)

  // Sleep: previous-night 23:30 → this-morning 07:15 (≈7h45m)
  const sleepStart = new Date(day); sleepStart.setHours(-1, 30, 0, 0)   // 23:30 prev day
  const sleepEnd = new Date(day);   sleepEnd.setHours(7, 15, 0, 0)
  sleepRecords.push({
    metadata: { id: idCounter() },
    startTime: isoFromLocal(sleepStart),
    endTime: isoFromLocal(sleepEnd),
    startZoneOffset: 'Z',
    endZoneOffset: 'Z',
    title: 'Night sleep',
    stages: [
      { startTime: isoFromLocal(sleepStart), endTime: isoFromLocal(new Date(sleepStart.getTime() + 30 * 60_000)), stage: 1 }, // awake/light
      { startTime: isoFromLocal(new Date(sleepStart.getTime() + 30 * 60_000)), endTime: isoFromLocal(new Date(sleepStart.getTime() + 3 * 3600_000)), stage: 4 }, // deep
      { startTime: isoFromLocal(new Date(sleepStart.getTime() + 3 * 3600_000)), endTime: isoFromLocal(new Date(sleepStart.getTime() + 6 * 3600_000)), stage: 5 }, // rem
      { startTime: isoFromLocal(new Date(sleepStart.getTime() + 6 * 3600_000)), endTime: isoFromLocal(sleepEnd), stage: 4 },
    ],
  })

  // RestingHR: 7:30am
  const rhrTime = new Date(day); rhrTime.setHours(7, 30, 0, 0)
  restingHrRecords.push({
    metadata: { id: idCounter() },
    time: isoFromLocal(rhrTime),
    zoneOffset: 'Z',
    beatsPerMinute: 56 + Math.round((Math.random() - 0.5) * 6),
  })

  // HRV (RMSSD): 7:30am
  hrvRecords.push({
    metadata: { id: idCounter() },
    time: isoFromLocal(rhrTime),
    zoneOffset: 'Z',
    heartRateVariabilityMillis: 42 + Math.round((Math.random() - 0.5) * 14),
  })

  // Weight: 7:30am
  weightRecords.push({
    metadata: { id: idCounter() },
    time: isoFromLocal(rhrTime),
    zoneOffset: 'Z',
    weightInKilograms: 78.5 + (Math.random() - 0.5),
  })

  // Exercise session: 17:00–17:35 run, with HR samples baked in via separate HeartRateRecord
  const exStart = new Date(day); exStart.setHours(17, 0, 0, 0)
  const exEnd = new Date(day);   exEnd.setHours(17, 35, 0, 0)
  exerciseRecords.push({
    metadata: { id: idCounter() },
    startTime: isoFromLocal(exStart),
    endTime: isoFromLocal(exEnd),
    startZoneOffset: 'Z',
    endZoneOffset: 'Z',
    exerciseType: 56,  // RUNNING in Health Connect
    title: 'Evening run',
    notes: 'Easy zone-2 ish',
  })

  // HR samples covering 06:00 to 22:00 (every 5 minutes, ~190 samples) — Android app
  // splits into chunks of 10 records, each record holding many samples. Mimic: one
  // HeartRateRecord per day with all the day's samples in `samples`.
  const hrSamples = []
  const dayStart = new Date(day); dayStart.setHours(6, 0, 0, 0)
  for (let m = 0; m < 16 * 60; m += 5) {
    const t = new Date(dayStart.getTime() + m * 60_000)
    // baseline ~70, peak to ~150 during the run window
    const localMin = t.getHours() * 60 + t.getMinutes()
    const runMin = 17 * 60
    let bpm = 68 + 5 * Math.sin(m / 90)
    if (Math.abs(localMin - runMin) < 17) bpm = 140 + 8 * Math.sin(m / 4)
    hrSamples.push({ time: isoFromLocal(t), beatsPerMinute: Math.round(bpm) })
  }
  hrSampleRecords.push({
    metadata: { id: idCounter() },
    startTime: isoFromLocal(dayStart),
    endTime: isoFromLocal(new Date(dayStart.getTime() + 16 * 3600_000)),
    startZoneOffset: 'Z',
    endZoneOffset: 'Z',
    samples: hrSamples,
  })

  // Daily aggregates: steps + active/total calories
  const dateKey = day.toISOString().slice(0, 10)
  stepsDailyAggs.push({ date: dateKey, value: 8500 + Math.round(Math.random() * 3000) })
  activeCaloriesDailyAggs.push({ date: dateKey, value: 380 + Math.round(Math.random() * 150) })
  totalCaloriesDailyAggs.push({ date: dateKey, value: 2300 + Math.round(Math.random() * 200) })
}

console.log('--- POST /api/sync/SleepSessionRecord ---')
await post('/sync/SleepSessionRecord', { data: sleepRecords })

console.log('--- POST /api/sync/RestingHeartRateRecord ---')
await post('/sync/RestingHeartRateRecord', { data: restingHrRecords })

console.log('--- POST /api/sync/HeartRateVariabilityRmssdRecord ---')
await post('/sync/HeartRateVariabilityRmssdRecord', { data: hrvRecords })

console.log('--- POST /api/sync/WeightRecord ---')
await post('/sync/WeightRecord', { data: weightRecords })

console.log('--- POST /api/sync/ExerciseSessionRecord ---')
await post('/sync/ExerciseSessionRecord', { data: exerciseRecords })

console.log('--- POST /api/sync/HeartRateRecord (one record per day, many samples) ---')
// Android chunks at 10 records per request; we have 8 days, send in one shot.
await post('/sync/HeartRateRecord', { data: hrSampleRecords })

console.log('--- POST /api/sync/daily-aggregates ---')
await post('/sync/daily-aggregates', {
  data: [
    ...stepsDailyAggs.map((a) => ({ metric: 'steps', date: a.date, value: a.value, data_origins: ['com.google.android.apps.fitness'] })),
    ...activeCaloriesDailyAggs.map((a) => ({ metric: 'calories_active', date: a.date, value: a.value, data_origins: ['com.google.android.apps.fitness'] })),
    ...totalCaloriesDailyAggs.map((a) => ({ metric: 'calories_total', date: a.date, value: a.value, data_origins: ['com.google.android.apps.fitness'] })),
  ],
})
