import { EventEmitter } from 'node:events';

import { Injectable } from '@nestjs/common';

import { DownloadServerEvent, DownloadServerTopic } from '@/gateways/protocols/download/topics';

@Injectable()
export class DownloadEventEmitter {
  private readonly emitter = new EventEmitter();

  emit<T extends DownloadServerTopic>(topic: T, payload: DownloadServerEvent<T>['payload']): void {
    this.emitter.emit(topic, payload);
  }

  on<T extends DownloadServerTopic>(topic: T, listener: (payload: DownloadServerEvent<T>['payload']) => void): void {
    this.emitter.on(topic, listener);
  }

  off<T extends DownloadServerTopic>(topic: T, listener: (payload: DownloadServerEvent<T>['payload']) => void): void {
    this.emitter.off(topic, listener);
  }
}
