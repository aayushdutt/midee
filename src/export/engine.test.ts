import { describe, expect, it } from 'vitest'
import { isWebKit } from './engine'

const UA = {
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0',
}

describe('isWebKit', () => {
  it('is true for Safari and every iOS browser (all WebKit, one encoder)', () => {
    for (const ua of [UA.safariMac, UA.safariIos, UA.chromeIos, UA.firefoxIos]) {
      expect(isWebKit(ua), ua).toBe(true)
    }
  })

  it('is false for Chromium (desktop, Edge, Android) and Firefox', () => {
    for (const ua of [UA.chromeMac, UA.edgeWin, UA.chromeAndroid, UA.firefoxMac]) {
      expect(isWebKit(ua), ua).toBe(false)
    }
  })
})
