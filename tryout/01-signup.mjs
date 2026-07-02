import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'

const SHOTS = '/tmp/aurboda-tryout/shots'
await mkdir(SHOTS, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'error' || t === 'warning') console.log(`[browser ${t}]`, msg.text())
})
page.on('pageerror', (err) => console.log('[pageerror]', err.message))

const log = (s) => console.log(`▶ ${s}`)

log('GET /')
await page.goto('http://localhost:8080/', { waitUntil: 'networkidle0' })
await page.screenshot({ path: `${SHOTS}/01-home-anon.png`, fullPage: true })
log(`landed at ${page.url()}`)

log('GET /signup')
await page.goto('http://localhost:8080/signup', { waitUntil: 'networkidle0' })
await page.screenshot({ path: `${SHOTS}/02-signup-passkey.png`, fullPage: true })

log('Type username')
await page.type('input#user', 'qsreddit_demo')

log('Click "Use a password instead"')
// Find the link by its visible text — robust against class names.
const switched = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find((el) =>
    el.textContent?.toLowerCase().includes('use a password'),
  )
  if (a) { a.click(); return true }
  return false
})
console.log('  switched?', switched)
await new Promise((r) => setTimeout(r, 300))
await page.screenshot({ path: `${SHOTS}/03-signup-password-form.png`, fullPage: true })

log('Fill password fields')
await page.type('input#pass', 'demopassword123!')
await page.type('input#confirmPass', 'demopassword123!')

log('Submit signup')
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
  page.click('button[type="submit"]'),
])
await new Promise((r) => setTimeout(r, 1000))
console.log('  after-submit URL:', page.url())
await page.screenshot({ path: `${SHOTS}/04-post-signup.png`, fullPage: true })

// Persist the auth token so we can use it for API calls
const auth = await page.evaluate(() => localStorage.getItem('auth'))
console.log('  auth blob:', auth?.slice(0, 200))

await browser.close()
