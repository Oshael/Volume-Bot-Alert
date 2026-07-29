import { apiFetch } from './base';

export interface XProfile {
  handle: string;
  name: string;
  profileUrl: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  location: string | null;
  websiteUrl: string | null;
  verified: boolean;
  verifiedType: string | null;
  isProtected: boolean;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  joinedAt: string | null;
  accountAgeDays: number | null;
}

export interface XProfileResponse {
  profile: XProfile;
  cached: boolean;
  stale: boolean;
}

export function fetchXProfile(handle: string) {
  return apiFetch<XProfileResponse>(`/api/x-profile/${encodeURIComponent(handle)}`, {
    method: 'GET',
  });
}
