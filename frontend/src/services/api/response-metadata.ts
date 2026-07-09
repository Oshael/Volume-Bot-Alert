export type ApiResponseMetadata = {
  status: number;
  ok: boolean;
  rateLimit: string | null;
  rateLimitPolicy: string | null;
  rateLimitLimit: string | null;
  rateLimitRemaining: string | null;
  rateLimitReset: string | null;
  retryAfter: string | null;
};

export const API_RESPONSE_DEBUG_EVENT = 'trendscope:api-response-debug';

export function readApiResponseMetadata(response: Pick<Response, 'status' | 'ok' | 'headers'>): ApiResponseMetadata {
  return {
    status: response.status,
    ok: response.ok,
    rateLimit: response.headers.get('RateLimit'),
    rateLimitPolicy: response.headers.get('RateLimit-Policy'),
    rateLimitLimit: response.headers.get('RateLimit-Limit'),
    rateLimitRemaining: response.headers.get('RateLimit-Remaining'),
    rateLimitReset: response.headers.get('RateLimit-Reset'),
    retryAfter: response.headers.get('Retry-After'),
  };
}

export function shouldEmitApiResponseDebug(metadata: ApiResponseMetadata) {
  return metadata.status >= 400
    || Boolean(metadata.retryAfter)
    || Boolean(metadata.rateLimit)
    || Boolean(metadata.rateLimitPolicy)
    || Boolean(metadata.rateLimitLimit)
    || Boolean(metadata.rateLimitRemaining)
    || Boolean(metadata.rateLimitReset);
}
