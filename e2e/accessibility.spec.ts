import { expect, test } from '@playwright/test'

const HOME_TITLE = 'midee - Free Online MIDI Player & Synthesia Alternative'

test.describe('App navigation accessibility', () => {
  test('the skip link stays offscreen before the app stylesheet loads', async ({ page }) => {
    await page.route('**/*.css', (route) => route.abort())
    await page.goto('/?lang=en')
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).not.toBeInViewport()
    await page.keyboard.press('Tab')
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
  })

  test('the first Tab reveals a skip link and Enter bypasses the top strip', async ({ page }) => {
    await page.goto('/?lang=en')
    await expect(page.locator('#home-open')).toBeVisible()
    await expect(page).toHaveTitle(HOME_TITLE)
    await expect(page.getByRole('main')).toHaveCount(1)
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).not.toBeInViewport()
    await page.keyboard.press('Tab')
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await page.keyboard.press('Enter')
    await expect(page.locator('#home-open')).toBeFocused()
    // Native keyboard navigation continues from the content, not the top strip.
    await page.keyboard.press('Tab')
    await expect(page.locator('#home-live')).toBeFocused()
    await expect(page).toHaveURL(/\?lang=en$/)
  })

  test('skip navigation follows Live mode and works when the HUD is collapsed', async ({ page }) => {
    await page.goto('/?lang=en')
    await page.locator('#home-live').click()
    await expect(page.locator('#hud-metro')).toBeVisible()
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await skip.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#hud-metro')).toBeFocused()
    await page.locator('#hud .float-hud__close').click()
    await skip.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#hud .float-hud__reopen')).toBeFocused()
    await page.locator('#ts-home').click()
    await expect(page).toHaveTitle(HOME_TITLE)
    await skip.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#home-open')).toBeFocused()
  })

  test('skip navigation reaches the Learn catalog', async ({ page }) => {
    await page.goto('/?lang=en')
    await page.locator('#home-learn').click()
    const firstExercise = page.locator('.learn-host--hub button').first()
    await expect(firstExercise).toBeVisible()
    await page.getByRole('link', { name: 'Skip to main content' }).focus()
    await page.keyboard.press('Enter')
    await expect(firstExercise).toBeFocused()
  })

  test('localized home metadata and skip link use the selected language', async ({ page }) => {
    await page.goto('/?lang=fr')
    await expect(page.locator('#home-open')).toBeVisible()
    await expect(page).toHaveTitle('midee - Lecteur MIDI gratuit en ligne et alternative à Synthesia')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Aller au contenu principal' })).toBeFocused()
  })
})
