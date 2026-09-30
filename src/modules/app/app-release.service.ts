import { Injectable, Logger } from '@nestjs/common';

export interface AppReleaseInfo {
  version: string;
  latestVersion: string;
  downloadUrl: string;
  bundleUrl?: string;
  releaseNotes: string;
  htmlUrl?: string;
  publishedAt?: string;
  source: 'cache' | 'github' | 'env' | 'fallback';
}

@Injectable()
export class AppReleaseService {
  private readonly logger = new Logger(AppReleaseService.name);

  // In-memory cache to avoid GitHub API rate limits
  private cachedRelease: AppReleaseInfo | null = null;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes

  // Default repositories to query
  private readonly primaryRepo = 'Icedmist/WavePass-App';
  private readonly fallbackRepo = 'Icedmist/WavePass-Android';

  async getLatestRelease(): Promise<AppReleaseInfo> {
    const now = Date.now();
    if (this.cachedRelease && now < this.cacheExpiresAt) {
      return { ...this.cachedRelease, source: 'cache' };
    }

    // 1. Check environment variable override
    const envVersion = process.env.APP_LATEST_VERSION;
    const envDownloadUrl = process.env.APP_DOWNLOAD_URL;
    if (envVersion && envDownloadUrl) {
      const release: AppReleaseInfo = {
        version: envVersion.replace(/^v/, ''),
        latestVersion: envVersion.replace(/^v/, ''),
        downloadUrl: envDownloadUrl,
        releaseNotes: process.env.APP_RELEASE_NOTES || 'Performance improvements and bug fixes.',
        htmlUrl: process.env.APP_RELEASE_HTML_URL || `https://github.com/${this.primaryRepo}/releases`,
        publishedAt: new Date().toISOString(),
        source: 'env',
      };
      this.cachedRelease = release;
      this.cacheExpiresAt = now + this.cacheTtlMs;
      return release;
    }

    // 2. Fetch from GitHub (WavePass-App public distribution repo first, then WavePass-Android)
    for (const repo of [this.primaryRepo, this.fallbackRepo]) {
      try {
        const release = await this.fetchReleaseFromGitHub(repo);
        if (release) {
          this.cachedRelease = release;
          this.cacheExpiresAt = now + this.cacheTtlMs;
          return release;
        }
      } catch (err: any) {
        this.logger.warn(`Failed to fetch release from ${repo}: ${err?.message || err}`);
      }
    }

    // 3. Fallback to default known configuration
    const fallbackRelease: AppReleaseInfo = {
      version: '1.0.1+2',
      latestVersion: '1.0.1+2',
      downloadUrl: `https://github.com/${this.primaryRepo}/releases/latest/download/app-release.apk`,
      releaseNotes: 'WavePass Mobile POS & Voucher Printing Client.',
      htmlUrl: `https://github.com/${this.primaryRepo}/releases`,
      publishedAt: new Date().toISOString(),
      source: 'fallback',
    };
    return fallbackRelease;
  }

  async getDownloadUrl(): Promise<string> {
    const release = await this.getLatestRelease();
    return release.downloadUrl;
  }

  private async fetchReleaseFromGitHub(repo: string): Promise<AppReleaseInfo | null> {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'WavePass-Backend-AppReleaseService',
    };

    const token = process.env.GH_RELEASE_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return null;
    }

    const data: any = await response.json();
    const tagName = data.tag_name || '';
    const cleanVersion = tagName.replace(/^v/, '');
    const releaseNotes = data.body || 'Performance improvements and bug fixes.';
    const htmlUrl = data.html_url || `https://github.com/${repo}/releases`;
    const publishedAt = data.published_at;

    let downloadUrl = `https://github.com/${repo}/releases/latest/download/app-release.apk`;
    let bundleUrl: string | undefined;

    if (Array.isArray(data.assets)) {
      const apkAsset = data.assets.find((a: any) => a.name?.toLowerCase().endsWith('.apk'));
      if (apkAsset?.browser_download_url) {
        downloadUrl = apkAsset.browser_download_url;
      }
      const aabAsset = data.assets.find((a: any) => a.name?.toLowerCase().endsWith('.aab'));
      if (aabAsset?.browser_download_url) {
        bundleUrl = aabAsset.browser_download_url;
      }
    }

    return {
      version: cleanVersion || '1.0.1',
      latestVersion: cleanVersion || '1.0.1',
      downloadUrl,
      bundleUrl,
      releaseNotes,
      htmlUrl,
      publishedAt,
      source: 'github',
    };
  }
}
