import { describe, expect, it } from 'vitest'
import { getIntelMacos13Support, isMacos12SupportNoticeEligible } from './macos-upgrade-support'

describe('macOS support notice', () => {
  it.each([
    ['darwin', '12.7.6', false, true],
    ['darwin', '12.7.6', true, false],
    ['darwin', '13.0', false, false],
    ['darwin', '21.6.0', false, false],
    ['darwin', '', false, false],
    ['linux', '12.0', false, false],
    ['win32', '12.0', false, false]
  ])('targets local Monterey only: %s %s web=%s', (platform, osRelease, webClient, eligible) => {
    expect(isMacos12SupportNoticeEligible({ platform, osRelease }, webClient)).toBe(eligible)
  })

  it.each([
    ['MacBook9,1', 'unsupported'],
    ['MacBook10,1', 'supported'],
    ['MacBookAir7,2', 'unsupported'],
    ['MacBookAir8,1', 'supported'],
    ['MacBookPro13,3', 'unsupported'],
    ['MacBookPro14,1', 'supported'],
    ['MacBookPro16,4', 'supported'],
    ['Macmini7,1', 'unsupported'],
    ['Macmini8,1', 'supported'],
    ['iMac17,1', 'unsupported'],
    ['iMac18,1', 'supported'],
    ['iMac20,2', 'supported'],
    ['iMacPro1,1', 'supported'],
    ['MacPro6,1', 'unsupported'],
    ['MacPro7,1', 'supported'],
    ['VirtualMac2,1', 'unknown'],
    ['MacBookPro99,1', 'unknown'],
    ['', 'unknown']
  ])('uses Apple’s Ventura model boundary for %s', (model, expected) => {
    expect(getIntelMacos13Support(model)).toBe(expected)
  })
})
