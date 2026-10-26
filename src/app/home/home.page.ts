import {
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  AfterViewInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonContent,
  IonFab,
  IonFabButton,
  IonIcon,
  ActionSheetController,
  ToastController,
  AlertController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  alertCircle,
  locate,
  closeCircle,
  search,
  home,
  briefcase,
  volumeHigh,
  volumeMute,
  navigate,
  add,
  arrowBack,
  car,
  swapVertical,
  ellipsisVertical,
  shareSocial,
  leaf,
  eye,
  eyeOff,
  trash,
} from 'ionicons/icons';
import { Geolocation } from '@capacitor/geolocation';
import * as maplibregl from 'maplibre-gl';
import type { Map, Marker, GeoJSONSource } from 'maplibre-gl';
import { environment } from '../../environments/environment';
import { ApiService, Report, ReportType, RouteResult } from '../services/api.service';
import { SocketService } from '../services/socket.service';
import { VoiceService } from '../services/voice.service';

const ICONS: Record<ReportType, string> = {
  police: '🚓',
  hazard: '⚠️',
  accident: '💥',
  closure: '⛔',
  traffic: '🚦',
};

function dist(a: [number, number], b: [number, number]) {
  const R = 6371000;
  const r = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(r(b[1] - a[1]) / 2) ** 2 +
    Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [CommonModule, FormsModule, IonContent, IonFab, IonFabButton, IonIcon],
})
export class HomePage implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private api = inject(ApiService);
  private sockets = inject(SocketService);
  public voice = inject(VoiceService);
  private sheet = inject(ActionSheetController);
  private toast = inject(ToastController);
  private alertCtrl = inject(AlertController);

  private map!: Map;
  private me?: Marker;
  private markers = new globalThis.Map<string, Marker>();
  private destMarker?: Marker;
  private routeCalloutMarkers: Marker[] = [];
  private watchId?: string;
  private pos?: { latitude: number; longitude: number; speed?: number | null; heading?: number | null };
  private fetchedAt?: [number, number];
  private lastSpokenStepIndex = -1;

  // App UI State Machine: 'idle' | 'preview' | 'navigating'
  uiState = signal<'idle' | 'preview' | 'navigating'>('idle');

  // Route Data
  allRoutes = signal<RouteResult[]>([]);
  activeRoute = signal<RouteResult | null>(null);
  destinationLabel = signal<string>('Destination');

  // Turn-by-Turn guidance signals
  banner = signal<{ text: string; meters: number } | null>(null);
  nextBanner = signal<{ text: string } | null>(null);
  currentStreetName = signal<string>('');
  eta = signal<{ km: number; min: number; arrivalTime: string; speedKmh: number } | null>(null);

  // Address search & Saved places
  searchQuery = '';
  searchResults = signal<{ name: string; lat: number; lng: number }[]>([]);
  isSearching = signal<boolean>(false);
  savedPlaces = signal<{ id: string; label: string; latitude: number; longitude: number }[]>([]);
  showMarkers = signal<boolean>(true);

  constructor() {
    addIcons({
      alertCircle,
      locate,
      closeCircle,
      search,
      home,
      briefcase,
      volumeHigh,
      volumeMute,
      navigate,
      add,
      arrowBack,
      car,
      swapVertical,
      ellipsisVertical,
      shareSocial,
      leaf,
      eye,
      eyeOff,
      trash,
    });
  }

  ngAfterViewInit() {
    if ((maplibregl as any).setWorkerUrl) {
      (maplibregl as any).setWorkerUrl('assets/maplibre-gl-worker.mjs');
    }

    const style = environment.tileStyleUrl
      ? environment.tileStyleUrl
      : {
          version: 8 as const,
          sources: {
            osm: {
              type: 'raster' as const,
              tiles: environment.rasterTiles,
              tileSize: 256,
              attribution: '© OpenStreetMap',
            },
          },
          layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
        };

    this.map = new maplibregl.Map({
      container: this.mapEl.nativeElement,
      style,
      center: [101.97, 2.75], // Centered around central peninsular Malaysia default
      zoom: 12,
      pitch: 0,
    });

    this.map.on('load', () => {
      // Primary Route Source & Layers
      this.map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#11239c', 'line-width': 11 },
      });
      this.map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1e30f3', 'line-width': 7 },
      });

      // Alternative Route 1
      this.map.addSource('alt-route-1', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'alt-route-1',
        type: 'line',
        source: 'alt-route-1',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8ca0ba', 'line-width': 6, 'line-opacity': 0.8 },
      });

      // Alternative Route 2
      this.map.addSource('alt-route-2', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'alt-route-2',
        type: 'line',
        source: 'alt-route-2',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#9eb3cb', 'line-width': 6, 'line-opacity': 0.8 },
      });
    });

    this.map.on('contextmenu', (e) => void this.requestRoute([e.lngLat.lng, e.lngLat.lat], 'Pinned Location'));

    this.sockets.connect();
    this.sockets.newReport$.subscribe((r) => this.addMarker(r));
    this.sockets.updated$.subscribe((r) => this.addMarker(r));
    this.sockets.expired$.subscribe((r) => this.removeMarker(r.id));

    void this.startTracking();
    void this.loadSavedPlaces();
  }

  async loadSavedPlaces() {
    const places = await this.api.getSavedPlaces();
    this.savedPlaces.set(places);
  }

  private async startTracking() {
    const handleCoords = (c: {
      latitude: number;
      longitude: number;
      speed: number | null;
      heading: number | null;
    }) => {
      this.onPosition(c);
    };

    try {
      const initial = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
      if (initial?.coords) handleCoords(initial.coords);
    } catch {
      if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            handleCoords({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              speed: pos.coords.speed,
              heading: pos.coords.heading,
            });
          },
          () => {
            if (!this.pos) {
              const center = this.map ? this.map.getCenter() : { lng: 101.97, lat: 2.75 };
              handleCoords({ latitude: center.lat, longitude: center.lng, speed: 0, heading: 0 });
            }
          },
          { enableHighAccuracy: true, timeout: 8000 },
        );
      }
    }

    try {
      this.watchId = await Geolocation.watchPosition({ enableHighAccuracy: true }, (p, err) => {
        if (err || !p) return;
        handleCoords(p.coords);
      });
    } catch {
      if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        navigator.geolocation.watchPosition((pos) => {
          handleCoords({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speed: pos.coords.speed,
            heading: pos.coords.heading,
          });
        });
      }
    }
  }

  private onPosition(c: {
    latitude: number;
    longitude: number;
    speed: number | null;
    heading: number | null;
  }) {
    const first = !this.pos;
    this.pos = c;
    const lngLat: [number, number] = [c.longitude, c.latitude];

    if (!this.me) {
      const el = document.createElement('div');
      el.className = 'me-puck';
      this.me = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
        .setLngLat(lngLat)
        .addTo(this.map);
    }

    const me = this.me;
    me.setLngLat(lngLat);

    // Dynamic camera follow during turn-by-turn navigation
    if (this.uiState() === 'navigating') {
      const bearing = c.heading != null && !Number.isNaN(c.heading) ? c.heading : this.map.getBearing();
      me.setRotation(bearing);
      this.map.easeTo({
        center: lngLat,
        bearing: bearing,
        pitch: 60, // 3D driver cockpit view
        zoom: 17.5,
        duration: 900,
      });
    } else {
      if (c.heading != null && !Number.isNaN(c.heading)) {
        me.setRotation(c.heading);
      }
      if (first && this.uiState() === 'idle') {
        this.map.easeTo({ center: lngLat, zoom: 14, duration: 800 });
      }
    }

    this.sockets.emitPosition(c);
    this.updateGuidance(lngLat, c.speed);

    // Refresh nearby reports when moving >1km
    if (!this.fetchedAt || dist(this.fetchedAt, lngLat) > 1000) {
      this.fetchedAt = lngLat;
      this.api
        .nearby(c.latitude, c.longitude)
        .then((rs) => rs.forEach((r) => this.addMarker(r)))
        .catch(() => undefined);
    }
  }

  /** Go to current location automatically with immediate GPS fetch */
  async recenterToCurrentLocation() {
    let lat: number | undefined = this.pos?.latitude;
    let lng: number | undefined = this.pos?.longitude;

    try {
      const live = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 });
      if (live?.coords) {
        lat = live.coords.latitude;
        lng = live.coords.longitude;
        this.pos = {
          latitude: lat,
          longitude: lng,
          speed: live.coords.speed,
          heading: live.coords.heading,
        };
      }
    } catch {
      // Use existing pos or browser geolocation
    }

    if (lat !== undefined && lng !== undefined) {
      this.map.easeTo({
        center: [lng, lat],
        zoom: this.uiState() === 'navigating' ? 17.5 : 16,
        pitch: this.uiState() === 'navigating' ? 60 : 0,
        bearing: this.pos?.heading || 0,
        duration: 1000,
      });
      void this.say('Centered on your location');
    } else {
      void this.say('Fetching current GPS location...');
    }
  }

  recenter() {
    this.recenterToCurrentLocation();
  }

  /** Toggle visibility of hazard signs / incident markers */
  toggleMarkersVisibility() {
    const next = !this.showMarkers();
    this.showMarkers.set(next);
    for (const marker of this.markers.values()) {
      const el = marker.getElement();
      if (el) el.style.display = next ? 'flex' : 'none';
    }
    void this.say(next ? 'Incident signs visible' : 'Incident signs hidden');
  }

  /** Remove / clear all hazard signs permanently from both screen and database */
  async clearAllHazards() {
    try {
      await this.api.clearAllReports();
    } catch {
      // Backend request fallback
    }
    for (const marker of this.markers.values()) {
      marker.remove();
    }
    this.markers.clear();
    void this.say('All hazard signs removed permanently');
  }

  toggleVoice() {
    this.voice.enabled = !this.voice.enabled;
    void this.say(this.voice.enabled ? 'Voice guidance ON' : 'Voice guidance MUTED');
  }

  private searchDebounceTimer?: any;

  onSearchInput() {
    if (!this.searchQuery || this.searchQuery.trim().length < 2) {
      if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
      this.searchResults.set([]);
      this.isSearching.set(false);
      return;
    }

    this.isSearching.set(true);
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);

    // Fast 250ms debounce for silky smooth auto-complete suggestions while typing
    this.searchDebounceTimer = setTimeout(async () => {
      const coords = this.pos ? { latitude: this.pos.latitude, longitude: this.pos.longitude } : undefined;
      const query = this.searchQuery.trim();
      if (!query || query.length < 2) return;
      const results = await this.api.searchAddress(query, coords);
      // Only set results if current query still matches to prevent stale overwrites
      if (this.searchQuery.trim() === query) {
        this.searchResults.set(results);
        this.isSearching.set(false);
      }
    }, 250);
  }

  async onSearchEnter() {
    if (!this.searchQuery || this.searchQuery.trim().length < 2) return;
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    
    const currentResults = this.searchResults();
    if (currentResults.length > 0) {
      this.selectSearchResult(currentResults[0]);
      return;
    }

    // If user hit enter before suggestions finished loading or without clicking dropdown
    this.isSearching.set(true);
    const coords = this.pos ? { latitude: this.pos.latitude, longitude: this.pos.longitude } : undefined;
    const freshResults = await this.api.searchAddress(this.searchQuery.trim(), coords);
    this.isSearching.set(false);
    
    if (freshResults.length > 0) {
      this.selectSearchResult(freshResults[0]);
    } else {
      void this.say('No location found. Please try another place name.');
    }
  }

  selectSearchResult(result: { name: string; lat: number; lng: number }) {
    this.searchResults.set([]);
    this.searchQuery = '';
    this.isSearching.set(false);
    void this.requestRoute([result.lng, result.lat], result.name);
  }

  formatDuration(seconds: number): string {
    const totalMinutes = Math.round(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) {
      return `${hours} hr ${minutes > 0 ? minutes + ' min' : ''}`;
    }
    return `${minutes} min`;
  }

  formatArrivalTime(durationSeconds: number): string {
    const arrivalDate = new Date(Date.now() + durationSeconds * 1000);
    return arrivalDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Step 1: Request Route Preview (like Google Maps "Overview" screen) */
  async requestRoute(dest: [number, number], label?: string) {
    if (!this.pos) {
      const center = this.map ? this.map.getCenter() : { lng: 101.97, lat: 2.75 };
      this.pos = { latitude: center.lat, longitude: center.lng, speed: 0, heading: 0 };
    }
    const currentPos = this.pos;
    this.destinationLabel.set(label ? label.split(',')[0] : 'Destination');

    try {
      const data = await this.api.route([currentPos.longitude, currentPos.latitude], dest);
      const routesList = data.routes && data.routes.length > 0 ? data.routes : [data];
      this.allRoutes.set(routesList);
      this.selectRoute(routesList[0], false);

      // Add/Update Destination Red Pin
      if (this.destMarker) this.destMarker.remove();
      const el = document.createElement('div');
      el.className = 'dest-pin';
      el.innerHTML = '📍';
      this.destMarker = new maplibregl.Marker({ element: el }).setLngLat(dest).addTo(this.map);

      // Fit map bounds to show complete route overview (just like Google Maps screenshot)
      const coordinates = routesList[0].geometry.coordinates;
      const bounds = coordinates.reduce(
        (b, coord) => b.extend(coord as [number, number]),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
      );

      this.map.fitBounds(bounds, {
        padding: { top: 120, bottom: 260, left: 50, right: 50 },
        pitch: 0,
        bearing: 0,
        duration: 1000,
      });

      this.uiState.set('preview');
      this.clearCalloutMarkers();
      this.renderRouteCallouts(routesList);
    } catch {
      void this.say('Could not compute route.');
    }
  }

  private ensureRouteLayers() {
    if (!this.map) return;
    if (!this.map.getSource('route')) {
      this.map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#11239c', 'line-width': 11 },
      });
      this.map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1e30f3', 'line-width': 7 },
      });
    }

    if (!this.map.getSource('alt-route-1')) {
      this.map.addSource('alt-route-1', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'alt-route-1',
        type: 'line',
        source: 'alt-route-1',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8ca0ba', 'line-width': 6, 'line-opacity': 0.8 },
      });
    }

    if (!this.map.getSource('alt-route-2')) {
      this.map.addSource('alt-route-2', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: 'alt-route-2',
        type: 'line',
        source: 'alt-route-2',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#9eb3cb', 'line-width': 6, 'line-opacity': 0.8 },
      });
    }
  }

  selectRoute(r: RouteResult, fit = true) {
    this.activeRoute.set(r);
    this.ensureRouteLayers();

    // Primary route
    const routeSource = this.map.getSource('route') as GeoJSONSource;
    if (routeSource) {
      routeSource.setData({
        type: 'Feature',
        properties: {},
        geometry: r.geometry,
      });
    }

    // Alternatives
    const otherRoutes = this.allRoutes().filter((route) => route !== r);
    const altSource1 = this.map.getSource('alt-route-1') as GeoJSONSource;
    if (altSource1) {
      altSource1.setData(
        otherRoutes[0]
          ? { type: 'Feature', properties: {}, geometry: otherRoutes[0].geometry }
          : { type: 'FeatureCollection', features: [] },
      );
    }

    const altSource2 = this.map.getSource('alt-route-2') as GeoJSONSource;
    if (altSource2) {
      altSource2.setData(
        otherRoutes[1]
          ? { type: 'Feature', properties: {}, geometry: otherRoutes[1].geometry }
          : { type: 'FeatureCollection', features: [] },
      );
    }

    if (fit) {
      const coordinates = r.geometry.coordinates;
      const bounds = coordinates.reduce(
        (b, coord) => b.extend(coord as [number, number]),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
      );
      this.map.fitBounds(bounds, { padding: { top: 120, bottom: 260, left: 50, right: 50 }, duration: 600 });
    }
  }

  private clearCalloutMarkers() {
    this.routeCalloutMarkers.forEach((m) => m.remove());
    this.routeCalloutMarkers = [];
  }

  private renderRouteCallouts(routes: RouteResult[]) {
    routes.forEach((r, idx) => {
      const coords = r.geometry.coordinates;
      const midPoint = coords[Math.floor(coords.length * 0.5)];
      if (!midPoint) return;

      const el = document.createElement('div');
      el.className = `route-bubble ${idx === 0 ? 'bubble-primary' : 'bubble-alt'}`;
      el.innerHTML = `
        <div class="bubble-time">${this.formatDuration(r.duration)}</div>
        <div class="bubble-sub">No tolls</div>
      `;
      el.onclick = () => this.selectRoute(r);

      const marker = new maplibregl.Marker({ element: el }).setLngLat(midPoint as [number, number]).addTo(this.map);
      this.routeCalloutMarkers.push(marker);
    });
  }

  /** Step 2: User taps "Start" -> Transitions to Google Maps Navigation Mode */
  startNavigation() {
    const r = this.activeRoute();
    if (!r || !this.pos) return;
    this.clearCalloutMarkers();

    this.uiState.set('navigating');
    this.lastSpokenStepIndex = -1;

    const speedKmh = Math.max(0, Math.round(this.pos.speed ? this.pos.speed * 3.6 : 0));
    this.eta.set({
      km: r.distance / 1000,
      min: r.duration / 60,
      arrivalTime: this.formatArrivalTime(r.duration),
      speedKmh,
    });

    // 3D Driver Cockpit Camera
    this.map.easeTo({
      center: [this.pos.longitude, this.pos.latitude],
      pitch: 60,
      zoom: 17.5,
      bearing: this.pos.heading || 0,
      duration: 1200,
    });

    const initialStep = r.steps[0];
    if (initialStep) {
      this.banner.set({ text: initialStep.instruction, meters: Math.round(initialStep.distance) });
      this.currentStreetName.set(initialStep.name || 'Current Road');
      this.voice.speak(`Head out towards ${this.destinationLabel()}. ${initialStep.instruction}`, true);
    }

    if (r.steps[1]) {
      this.nextBanner.set({ text: r.steps[1].instruction });
    }

    this.updateGuidance([this.pos.longitude, this.pos.latitude], this.pos.speed ?? 0);
  }

  cancelRoute() {
    this.clearCalloutMarkers();
    this.allRoutes.set([]);
    this.activeRoute.set(null);
    this.uiState.set('idle');

    this.banner.set(null);
    this.nextBanner.set(null);
    this.eta.set(null);
    this.voice.stop();
    this.voice.speak('Navigation finished');

    if (this.destMarker) {
      this.destMarker.remove();
      this.destMarker = undefined;
    }

    (this.map.getSource('route') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    (this.map.getSource('alt-route-1') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    (this.map.getSource('alt-route-2') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });

    this.map.easeTo({ pitch: 0, zoom: 14, bearing: 0, duration: 800 });
  }

  private updateGuidance(me: [number, number], speedMps: number | null) {
    const route = this.activeRoute();
    if (!route || this.uiState() !== 'navigating') return;

    const steps = route.steps;
    const stepIdx = steps.findIndex((s, i) => i > 0 && dist(me, s.location) > 25);

    if (stepIdx === -1) {
      this.banner.set({ text: 'You have arrived!', meters: 0 });
      this.nextBanner.set(null);
      if (this.lastSpokenStepIndex !== 999999) {
        this.voice.speak('You have arrived at your destination.');
        this.lastSpokenStepIndex = 999999;
      }
      return;
    }

    const currentStep = steps[stepIdx];
    const distanceMeters = Math.round(dist(me, currentStep.location));
    this.banner.set({ text: currentStep.instruction, meters: distanceMeters });
    this.currentStreetName.set(currentStep.name || 'Current Road');

    if (steps[stepIdx + 1]) {
      this.nextBanner.set({ text: steps[stepIdx + 1].instruction });
    } else {
      this.nextBanner.set(null);
    }

    if (this.lastSpokenStepIndex !== stepIdx) {
      this.lastSpokenStepIndex = stepIdx;
      const distPrompt = distanceMeters > 300 ? `In ${distanceMeters} meters, ` : '';
      this.voice.speak(`${distPrompt}${currentStep.instruction}`);
    } else if (distanceMeters <= 80 && distanceMeters >= 40) {
      this.voice.speak(currentStep.instruction);
    }

    const currentSpeed = speedMps ? Math.round(speedMps * 3.6) : 0;

    // Calculate remaining distance to destination (distance to current maneuver + remaining steps)
    let remainingMeters = distanceMeters;
    for (let i = stepIdx + 1; i < steps.length; i++) {
      remainingMeters += steps[i].distance;
    }
    const remainingKm = Math.max(0.1, remainingMeters / 1000);
    const remainingMin = Math.max(1, (remainingMeters / 1000) / (Math.max(currentSpeed, 40) / 60));

    if (this.eta()) {
      this.eta.update((val) =>
        val
          ? {
              ...val,
              km: remainingKm,
              min: remainingMin,
              speedKmh: currentSpeed,
            }
          : null,
      );
    }
  }

  async handleSavedPlaceClick(place: { id: string; label: string; latitude: number; longitude: number }) {
    void this.requestRoute([place.longitude, place.latitude], place.label);
  }

  async promptAddSavedPlace(label: string) {
    if (!this.pos) return this.say('Waiting for GPS...');
    const alert = await this.alertCtrl.create({
      header: `Save Current Location as ${label}`,
      message: `Do you want to save your current position as ${label}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save',
          handler: async () => {
            if (!this.pos) return;
            await this.api.savePlace(label, this.pos.latitude, this.pos.longitude);
            await this.loadSavedPlaces();
            void this.say(`${label} saved!`);
          },
        },
      ],
    });
    await alert.present();
  }

  async openReportSheet() {
    const types: ReportType[] = ['police', 'hazard', 'accident', 'closure', 'traffic'];
    const s = await this.sheet.create({
      header: 'Report Live Hazard / Traffic',
      buttons: [
        ...types.map((t) => ({
          text: `${ICONS[t]}  ${t[0].toUpperCase()}${t.slice(1)}`,
          handler: () => void this.submit(t),
        })),
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    await s.present();
  }

  private async submit(type: ReportType) {
    let c = this.pos;
    if (!c) {
      try {
        c = (await Geolocation.getCurrentPosition({ enableHighAccuracy: true })).coords;
      } catch {
        return this.say('Location unavailable');
      }
    }
    try {
      this.addMarker(await this.api.createReport(type, c.latitude, c.longitude));
      void this.say('Hazard reported!');
    } catch {
      void this.say('Could not send report.');
    }
  }

  private addMarker(r: Report) {
    this.removeMarker(r.id);
    if (!r.isActive) return;
    const el = document.createElement('div');
    el.className = 'incident';
    el.textContent = ICONS[r.type];
    el.onclick = () => void this.openVerify(r);
    this.markers.set(
      r.id,
      new maplibregl.Marker({ element: el }).setLngLat([r.longitude, r.latitude]).addTo(this.map),
    );
  }

  private removeMarker(id: string) {
    this.markers.get(id)?.remove();
    this.markers.delete(id);
  }

  private async openVerify(r: Report) {
    const s = await this.sheet.create({
      header: `${ICONS[r.type]} ${r.type.toUpperCase()} · 👍 ${r.upvotes}  👎 ${r.downvotes}`,
      subHeader: 'Is this alert still active?',
      buttons: [
        {
          text: 'Still there 👍',
          handler: () => void this.api.verify(r.id, 'up').then((u) => this.addMarker(u)),
        },
        {
          text: 'Cleared / Not there 👎',
          handler: () => void this.api.verify(r.id, 'down').then((u) => this.addMarker(u)),
        },
        {
          text: '🗑️ Remove This Sign',
          role: 'destructive',
          handler: async () => {
            await this.api.removeReport(r.id);
            this.removeMarker(r.id);
            void this.say('Sign removed permanently');
          },
        },
        { text: 'Dismiss', role: 'cancel' },
      ],
    });
    await s.present();
  }

  private async say(message: string) {
    (await this.toast.create({ message, duration: 2500, position: 'top' })).present();
  }

  ngOnDestroy() {
    if (this.watchId) void Geolocation.clearWatch({ id: this.watchId });
    this.map?.remove();
    this.voice.stop();
  }
}
