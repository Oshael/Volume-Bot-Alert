import { apiFetch } from './base';

export interface InviteValidationResponse {
  valid: boolean;
  reason?: string;
  invite?: {
    code: string;
    created_by?: number | null;
    max_uses?: number | null;
    uses_count?: number | null;
    expires_at?: string | null;
    is_revoked?: boolean;
  };
}

export function validateInviteCode(code: string) {
  return apiFetch<InviteValidationResponse>(`/api/invites/validate/${encodeURIComponent(code)}`, {
    method: 'GET',
    token: null,
  });
}
