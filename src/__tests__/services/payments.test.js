// src/__tests__/services/payments.test.js
const { normalizeStatus } = require('../../services/payments');

describe('normalizeStatus', () => {
  describe('Kaspi Pay', () => {
    it('PAID → paid',    () => expect(normalizeStatus('kaspi', 'PAID')).toBe('paid'));
    it('PENDING → pending', () => expect(normalizeStatus('kaspi', 'PENDING')).toBe('pending'));
    it('FAILED → failed',   () => expect(normalizeStatus('kaspi', 'FAILED')).toBe('failed'));
    it('EXPIRED → expired', () => expect(normalizeStatus('kaspi', 'EXPIRED')).toBe('expired'));
    it('UNKNOWN → unknown', () => expect(normalizeStatus('kaspi', 'UNKNOWN')).toBe('unknown'));
  });

  describe('Halyk Bank', () => {
    it('CHARGED → paid',      () => expect(normalizeStatus('halyk', 'CHARGED')).toBe('paid'));
    it('AUTHORIZED → pending',() => expect(normalizeStatus('halyk', 'AUTHORIZED')).toBe('pending'));
    it('NEW → pending',       () => expect(normalizeStatus('halyk', 'NEW')).toBe('pending'));
    it('FAILED → failed',     () => expect(normalizeStatus('halyk', 'FAILED')).toBe('failed'));
    it('REFUND → refunded',   () => expect(normalizeStatus('halyk', 'REFUND')).toBe('refunded'));
  });

  it('неизвестный провайдер → unknown', () => {
    expect(normalizeStatus('unknown_provider', 'PAID')).toBe('unknown');
  });
});
