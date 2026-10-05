import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppReleaseService } from '../src/modules/app/app-release.service';
import { AppReleaseController } from '../src/modules/app/app-release.controller';

describe('AppReleaseModule unit tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('AppReleaseService', () => {
    it('returns env variable override when APP_LATEST_VERSION and APP_DOWNLOAD_URL are set', async () => {
      process.env.APP_LATEST_VERSION = 'v1.5.0';
      process.env.APP_DOWNLOAD_URL = 'https://custom-host.com/wavepass.apk';
      process.env.APP_RELEASE_NOTES = 'Special custom release';

      const service = new AppReleaseService();
      const release = await service.getLatestRelease();

      expect(release.version).toBe('1.5.0');
      expect(release.latestVersion).toBe('1.5.0');
      expect(release.downloadUrl).toBe('https://custom-host.com/wavepass.apk');
      expect(release.releaseNotes).toBe('Special custom release');
      expect(release.source).toBe('env');
    });

    it('fetches release from GitHub and extracts APK download URL', async () => {
      const mockGitHubRelease = {
        tag_name: 'v1.0.3',
        body: 'Automated release test.',
        html_url: 'https://github.com/Icedmist/WavePass-App/releases/tag/v1.0.3',
        published_at: '2026-09-30T10:00:00Z',
        assets: [
          {
            name: 'app-release.apk',
            browser_download_url: 'https://github.com/Icedmist/WavePass-App/releases/download/v1.0.3/app-release.apk',
          },
          {
            name: 'app-release.aab',
            browser_download_url: 'https://github.com/Icedmist/WavePass-App/releases/download/v1.0.3/app-release.aab',
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockGitHubRelease,
      } as any);

      const service = new AppReleaseService();
      const release = await service.getLatestRelease();

      expect(release.version).toBe('1.0.3');
      expect(release.downloadUrl).toBe('https://github.com/Icedmist/WavePass-App/releases/download/v1.0.3/app-release.apk');
      expect(release.bundleUrl).toBe('https://github.com/Icedmist/WavePass-App/releases/download/v1.0.3/app-release.aab');
      expect(release.source).toBe('github');

      // Subsequent call should return cached release
      const cached = await service.getLatestRelease();
      expect(cached.source).toBe('cache');
      expect(cached.version).toBe('1.0.3');
    });

    it('falls back to default fallback info when all GitHub requests fail', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('GitHub unreachable'));

      const service = new AppReleaseService();
      const release = await service.getLatestRelease();

      expect(release.version).toBe('1.0.3+4');
      expect(release.downloadUrl).toContain('app-release.apk');
      expect(release.source).toBe('fallback');
    });

    it('getDownloadUrl returns the direct APK url', async () => {
      process.env.APP_LATEST_VERSION = 'v1.0.5';
      process.env.APP_DOWNLOAD_URL = 'https://download.nexawavepass.com/app.apk';

      const service = new AppReleaseService();
      const url = await service.getDownloadUrl();

      expect(url).toBe('https://download.nexawavepass.com/app.apk');
    });
  });

  describe('AppReleaseController', () => {
    it('getVersion returns release info from service', async () => {
      const mockService: any = {
        getLatestRelease: vi.fn(async () => ({
          version: '1.0.2',
          latestVersion: '1.0.2',
          downloadUrl: 'https://example.com/apk',
          releaseNotes: 'Bug fixes',
          source: 'github',
        })),
      };

      const controller = new AppReleaseController(mockService);
      const res = await controller.getVersion();

      expect(res.version).toBe('1.0.2');
      expect(res.downloadUrl).toBe('https://example.com/apk');
      expect(mockService.getLatestRelease).toHaveBeenCalled();
    });

    it('downloadApk redirects 302 to download URL', async () => {
      const mockService: any = {
        getDownloadUrl: vi.fn(async () => 'https://example.com/apk-direct-download'),
      };

      const headerSpy = vi.fn().mockReturnThis();
      const sendSpy = vi.fn().mockReturnThis();
      const mockReply: any = {
        status: vi.fn().mockImplementation((code: number) => {
          expect(code).toBe(302);
          return {
            header: headerSpy,
            send: sendSpy,
          };
        }),
      };

      const controller = new AppReleaseController(mockService);
      await controller.downloadApk(mockReply);

      expect(mockService.getDownloadUrl).toHaveBeenCalled();
      expect(headerSpy).toHaveBeenCalledWith('Location', 'https://example.com/apk-direct-download');
      expect(sendSpy).toHaveBeenCalled();
    });
  });
});
