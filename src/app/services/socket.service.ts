import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { Report } from './api.service';

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket?: Socket;
  readonly newReport$ = new Subject<Report>();
  readonly updated$ = new Subject<Report>();
  readonly expired$ = new Subject<Report>();
  private lastSent = 0;

  connect() {
    if (this.socket) return;
    this.socket = io(`${environment.apiUrl}/traffic`, { transports: ['websocket'] });
    this.socket.on('report:new', (r: Report) => this.newReport$.next(r));
    this.socket.on('report:updated', (r: Report) => this.updated$.next(r));
    this.socket.on('report:expired', (r: Report) => this.expired$.next(r));
  }

  /** Throttled to one update every 3s. */
  emitPosition(c: { latitude: number; longitude: number; speed: number | null; heading: number | null }) {
    const now = Date.now();
    if (now - this.lastSent < 3000) return;
    this.lastSent = now;
    this.socket?.emit('position', {
      lat: c.latitude,
      lng: c.longitude,
      speed: c.speed ?? undefined,
      heading: c.heading ?? undefined,
    });
  }
}
