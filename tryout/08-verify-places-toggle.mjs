// Verify PR #756 / issue #655: Places page can toggle auto_create_activity.
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle0' })
await page.type('input#user', 'qsreddit_demo')
await page.type('input#pass', 'demopassword123!')
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null),
  page.click('button[type="submit"]'),
])

await page.goto('http://localhost:8080/places', { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, 1500))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/34-places-listing.png', fullPage: true })

// Try to find "Home" in the named-places list and click it.
const clickedHome = await page.evaluate(() => {
  const candidates = [...document.querySelectorAll('button, li, div, span, a')]
  for (const el of candidates) {
    const txt = (el.textContent || '').trim()
    if (txt === 'Home') {
      ;(el.closest('button') || el).click()
      return { text: txt, tag: el.tagName }
    }
  }
  return null
})
console.log('clicked Home?', clickedHome)
await new Promise((r) => setTimeout(r, 1000))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/35-places-edit-modal.png', fullPage: true })

const modalInfo = await page.evaluate(() => {
  // Try to find the auto_create_activity checkbox + its label.
  const inputs = [...document.querySelectorAll('input[type="checkbox"]')]
  return inputs.map((i) => {
    const labelEl = i.closest('label') || (i.id ? document.querySelector(`label[for="${i.id}"]`) : null)
    return {
      name: i.name,
      id: i.id,
      checked: i.checked,
      labelText: labelEl?.textContent?.trim(),
    }
  })
})
console.log('checkboxes seen:', JSON.stringify(modalInfo, null, 2))

// Flip the auto-create checkbox if present and save.
const flipped = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input[type="checkbox"]')]
  const target = inputs.find((i) => {
    const labelEl = i.closest('label') || (i.id ? document.querySelector(`label[for="${i.id}"]`) : null)
    return /auto.*activity|create activity|auto-create/i.test(labelEl?.textContent || '')
  })
  if (!target) return false
  target.click()
  return { name: target.name, checkedAfter: target.checked }
})
console.log('flipped?', flipped)
await new Promise((r) => setTimeout(r, 300))

const saved = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')]
  const save = buttons.find((b) => /^save$|^update$/i.test((b.textContent || '').trim()))
  if (save && !save.disabled) {
    save.click()
    return true
  }
  return false
})
console.log('clicked Save?', saved)
await new Promise((r) => setTimeout(r, 1200))
await page.screenshot({ path: '/tmp/aurboda-tryout/shots/36-places-after-save.png', fullPage: true })

await browser.close()
