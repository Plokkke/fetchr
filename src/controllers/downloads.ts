import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';

import { MatchingHeaders } from '@/decorators/MatchingHeaders';
import { MatchingHeadersGuard } from '@/guards/MatchingHeaderGuard';
import { FileInfo } from '@/plugins/host-plugin';
import { DownloadingInfos, DownloadItem, DownloadStatus } from '@/schemas/DownloadItem';
import { DownloadEngine } from '@/services/download-engine';

@Controller('/downloads')
@MatchingHeaders([{ headerKey: 'x-api-key', configPath: 'server.apiKey' }])
@UseGuards(MatchingHeadersGuard)
export class DownloadController {
  constructor(private readonly engine: DownloadEngine) {}

  @Get('/resolve')
  async resolve(@Query('url') url: string): Promise<FileInfo> {
    return this.engine.resolve(url);
  }

  @Post('/')
  async createDownload(@Body() item: DownloadItem): Promise<DownloadingInfos> {
    return this.engine.download(item);
  }

  @Get('/')
  listDownloads(): DownloadingInfos[] {
    return this.engine.list();
  }

  @Delete('/completed')
  clearCompleted(): { cleared: number } {
    const count = this.engine.clearCompleted();
    return { cleared: count };
  }

  @Get('/:id')
  getDownload(@Param('id') id: string): DownloadingInfos {
    const item = this.engine.get(id);
    if (!item) {
      throw new NotFoundException();
    }
    return item;
  }

  @Delete('/:id')
  cancelDownload(@Param('id') id: string): { success: boolean } {
    const item = this.getDownload(id);
    if (item.status === DownloadStatus.Completed || item.status === DownloadStatus.Failed) {
      this.engine.remove(item.id);
    } else {
      this.engine.cancel(id);
    }
    return { success: true };
  }
}
