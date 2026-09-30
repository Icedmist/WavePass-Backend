import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AppReleaseService } from './app-release.service';

@Controller('app')
export class AppReleaseController {
  constructor(private readonly appReleaseService: AppReleaseService) {}

  @Get('version')
  async getVersion() {
    return this.appReleaseService.getLatestRelease();
  }

  @Get('download')
  async downloadApk(@Res() res: FastifyReply) {
    const downloadUrl = await this.appReleaseService.getDownloadUrl();
    return res.status(302).header('Location', downloadUrl).send();
  }
}
