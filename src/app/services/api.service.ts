import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export type ReportType = 'police' | 'hazard' | 'accident' | 'closure' | 'traffic';

export interface Report {
  id: string;
  type: ReportType;
  latitude: number;
  longitude: number;
  upvotes: number;
  downvotes: number;
  isActive: boolean;
  distance?: number;
}

export interface Step {
  instruction: string;
  distance: number;
  name: string;
  maneuver: string;
  modifier: string | null;
  location: [number, number];
}

export interface RouteResult {
  index?: number;
  distance: number;
  duration: number;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  steps: Step[];
  summary?: string;
  routes?: RouteResult[];
}

const ROUTE_CACHE = 'routely.routes.v1';

@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly deviceId = this.getDeviceId();

  private getDeviceId() {
    let id = localStorage.getItem('routely.deviceId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('routely.deviceId', id);
    }
    return id;
  }

  async nearby(lat: number, lng: number, radiusInMeters = 5000): Promise<Report[]> {
    const r = await fetch(
      `${environment.apiUrl}/api/v1/reports/nearby?lat=${lat}&lng=${lng}&radiusInMeters=${radiusInMeters}`,
    );
    if (!r.ok) throw new Error('nearby failed');
    return r.json();
  }

  async createReport(type: ReportType, latitude: number, longitude: number): Promise<Report> {
    const r = await fetch(`${environment.apiUrl}/api/v1/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, latitude, longitude }),
    });
    if (!r.ok) throw new Error('report failed');
    return r.json();
  }

  async verify(id: string, vote: 'up' | 'down'): Promise<Report> {
    const r = await fetch(`${environment.apiUrl}/api/v1/reports/${id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId, vote }),
    });
    if (!r.ok) throw new Error('verify failed');
    return r.json();
  }

  async clearAllReports(): Promise<{ cleared: number }> {
    const r = await fetch(`${environment.apiUrl}/api/v1/reports/clear`, {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error('clear reports failed');
    return r.json();
  }

  async removeReport(id: string): Promise<{ success: boolean }> {
    const r = await fetch(`${environment.apiUrl}/api/v1/reports/${id}`, {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error('delete report failed');
    return r.json();
  }

  /** Fetches a route; falls back to the last cached route when offline. */
  async route(from: [number, number], to: [number, number]): Promise<RouteResult> {
    const q = `startLng=${from[0]}&startLat=${from[1]}&destLng=${to[0]}&destLat=${to[1]}`;
    const key = `${ROUTE_CACHE}:${from.map((n) => n.toFixed(3))}:${to.map((n) => n.toFixed(3))}`;
    try {
      const r = await fetch(`${environment.apiUrl}/api/v1/routes?${q}`);
      if (!r.ok) throw new Error('route failed');
      const data: RouteResult = await r.json();
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch {
        /* storage full */
      }
      return data;
    } catch (e) {
      const cached = localStorage.getItem(key);
      if (cached) return JSON.parse(cached);
      throw e;
    }
  }

  /** Search places via backend geocoding proxy with proximity bias */
  async searchAddress(
    query: string,
    userCoords?: { latitude: number; longitude: number },
  ): Promise<{ name: string; lat: number; lng: number }[]> {
    if (!query || query.trim().length < 2) return [];
    try {
      let url = `${environment.apiUrl}/api/v1/search?q=${encodeURIComponent(query)}`;
      if (userCoords) {
        url += `&lat=${userCoords.latitude}&lng=${userCoords.longitude}`;
      }
      const res = await fetch(url);
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  }

  async getSavedPlaces(): Promise<{ id: string; label: string; latitude: number; longitude: number }[]> {
    try {
      const r = await fetch(`${environment.apiUrl}/api/v1/places?deviceId=${this.deviceId}`);
      if (!r.ok) return [];
      return r.json();
    } catch {
      return [];
    }
  }

  async savePlace(label: string, latitude: number, longitude: number) {
    const r = await fetch(`${environment.apiUrl}/api/v1/places`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId, label, latitude, longitude }),
    });
    return r.json();
  }

  async deleteSavedPlace(id: string) {
    await fetch(`${environment.apiUrl}/api/v1/places/${id}?deviceId=${this.deviceId}`, {
      method: 'DELETE',
    });
  }
}

