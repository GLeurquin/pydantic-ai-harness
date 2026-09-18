import { errorMessage } from './errors';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message of an Error subclass', () => {
    class ApiError extends Error {}
    expect(errorMessage(new ApiError('not found'))).toBe('not found');
  });

  it('stringifies a plain string', () => {
    expect(errorMessage('rejected')).toBe('rejected');
  });

  it('stringifies a non-Error object', () => {
    expect(errorMessage({ code: 500 })).toBe('[object Object]');
  });

  it('stringifies null and undefined', () => {
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
