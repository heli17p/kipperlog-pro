
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { TruckType, Site, Load, AppState, LoadingPoint, CustomMaterial } from './types';
import { Icons } from './constants';

const STORAGE_KEY = 'kipper_log_app_data_v16';
const LOADING_ZONE_RADIUS_DEFAULT = 25; 
const DEFAULT_SITE_RADIUS = 200; 
const DETECTION_DELAY_MS = 5000; 
const RESET_COOLDOWN_MS = 3000; 
const ACCURACY_THRESHOLD = 50; // Meter: Signale ungenauer als 50m werden für die Automatik ignoriert

const DEFAULT_MATERIALS: CustomMaterial[] = [
  { id: '1', name: 'Aushub', colorClass: 'bg-amber-600' },
  { id: '2', name: 'Betonabbruch', colorClass: 'bg-slate-500' },
  { id: '3', name: 'Bauschutt', colorClass: 'bg-red-700' },
  { id: '4', name: 'Asphaltabbruch', colorClass: 'bg-neutral-800' },
  { id: '5', name: 'Humus', colorClass: 'bg-emerald-600' },
  { id: '6', name: 'Sonstiges', colorClass: 'bg-blue-600' }
];

const COLOR_PALETTE = [
  'bg-amber-600', 'bg-slate-500', 'bg-red-700', 'bg-neutral-800', 
  'bg-blue-600', 'bg-emerald-600', 'bg-orange-500', 'bg-purple-600', 
  'bg-pink-600', 'bg-cyan-600', 'bg-lime-600'
];

type TotalDisplayMode = 'total' | 'today' | 'week' | 'month' | 'year';

declare const L: any; 

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'track' | 'history' | 'stats' | 'settings'>('track');
  const [currentCoords, setCurrentCoords] = useState<{lat: number, lon: number, accuracy: number} | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [gpsRetryKey, setGpsRetryKey] = useState<number>(0); 
  const [activeAutoLoadId, setActiveAutoLoadId] = useState<string | null>(null);
  const [showMaterialPicker, setShowMaterialPicker] = useState<boolean>(false);
  const [autoCenter, setAutoCenter] = useState<boolean>(true);
  const [pendingPointCoords, setPendingPointCoords] = useState<{lat: number, lon: number} | null>(null);
  const [newSiteName, setNewSiteName] = useState('');
  const [mapMode, setMapMode] = useState<'standard' | 'satellite'>('standard');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isMapLocked, setIsMapLocked] = useState<boolean>(true);
  
  const [totalDisplayMode, setTotalDisplayMode] = useState<TotalDisplayMode>('total');
  const [statsFilter, setStatsFilter] = useState<'today' | 'week' | 'day' | 'all'>('today');
  const [historyFilter, setHistoryFilter] = useState<'today' | 'yesterday' | 'week' | 'all'>('today');
  const [selectedStatsDate, setSelectedStatsDate] = useState(new Date().toISOString().split('T')[0]);

  const [detectionProgress, setDetectionProgress] = useState<number>(0); 
  const detectionTimeoutRef = useRef<any>(null);
  const detectionStartTimeRef = useRef<number | null>(null);
  const hasCanceledCurrentZoneRef = useRef<string | null>(null);
  const lastManualResetTimeRef = useRef<number>(0);

  const [editingPoint, setEditingPoint] = useState<{siteId: string, pointId: string} | null>(null);
  const [editingSite, setEditingSite] = useState<string | null>(null); 
  const [editingLoadId, setEditingLoadId] = useState<string | null>(null);

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showConfirmCancel, setShowConfirmCancel] = useState<boolean>(false);
  const [siteDeleteConfirm, setSiteDeleteConfirm] = useState<boolean>(false);
  const [newMaterialName, setNewMaterialName] = useState<string>('');
  const [showMaterialManager, setShowMaterialManager] = useState<boolean>(false);

  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const isInLoadingZoneRef = useRef<string | null>(null); 
  const markerLayerGroupRef = useRef<any>(null);
  const tileLayerRef = useRef<any>(null);

  const [state, setState] = useState<AppState & { stayAwake: boolean }>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
    return {
      sites: [],
      loads: [],
      materials: DEFAULT_MATERIALS,
      activeSiteId: null,
      currentTruckType: TruckType.AXLE_4,
      autoDetectEnabled: true,
      autoCountEnabled: true,
      stayAwake: true, 
    };
  });

  const getMaterialColor = (matName: string) => {
    const mat = state.materials.find(m => m.name === matName);
    return mat ? mat.colorClass : 'bg-slate-700';
  };

  const sitesRef = useRef(state.sites);
  useEffect(() => { sitesRef.current = state.sites; }, [state.sites]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    let wakeLockSentinel: any = null;

    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && state.stayAwake) {
        try {
          wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
          wakeLockSentinel.addEventListener('release', () => {
            if (state.stayAwake && document.visibilityState === 'visible') {
              requestWakeLock();
            }
          });
        } catch (err) {
          console.error(`Wake Lock Fehler: ${err}`);
        }
      }
    };

    if (state.stayAwake) {
      requestWakeLock();
    }

    const handleVisibilityChange = async () => {
      if (state.stayAwake && document.visibilityState === 'visible') {
        await requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockSentinel) {
        wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    };
  }, [state.stayAwake]);

  useEffect(() => {
    const handleStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', handleStatus);
    window.addEventListener('offline', handleStatus);
    return () => {
      window.removeEventListener('online', handleStatus);
      window.removeEventListener('offline', handleStatus);
    };
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setLocationError("Dein Browser unterstützt kein GPS.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocationError(null);
        const coords = { 
          lat: pos.coords.latitude, 
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy 
        };
        setCurrentCoords(coords);
        if (mapRef.current && autoCenter && activeTab === 'track') {
          mapRef.current.setView([coords.lat, coords.lon], mapRef.current.getZoom());
        }
      },
      (err) => {
        switch(err.code) {
          case 1: setLocationError("Standortzugriff verweigert. Bitte in den Einstellungen erlauben."); break;
          case 2: setLocationError("GPS Signal verloren oder GPS am Handy ist ausgeschaltet."); break;
          case 3: setLocationError("GPS Zeitüberschreitung. Versuche es erneut."); break;
          default: setLocationError("Unbekannter GPS-Fehler.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [activeTab, autoCenter, gpsRetryKey]);

  const handleGpsRetry = () => {
    setLocationError(null);
    setGpsRetryKey(prev => prev + 1);
  };

  const cycleTotalDisplay = () => {
    const modes: TotalDisplayMode[] = ['total', 'today', 'week', 'month', 'year'];
    const currentIndex = modes.indexOf(totalDisplayMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    setTotalDisplayMode(modes[nextIndex]);
  };

  const summaryVolume = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startOfWeek = new Date(new Date(now).setDate(diff)).setHours(0,0,0,0);
    
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();

    const filtered = state.loads.filter(l => {
      if (totalDisplayMode === 'total') return true;
      if (totalDisplayMode === 'today') return l.timestamp >= startOfToday;
      if (totalDisplayMode === 'week') return l.timestamp >= startOfWeek;
      if (totalDisplayMode === 'month') return l.timestamp >= startOfMonth;
      if (totalDisplayMode === 'year') return l.timestamp >= startOfYear;
      return true;
    });
    return filtered.reduce((sum, l) => sum + l.volume, 0);
  }, [state.loads, totalDisplayMode]);

  const totalLabel = useMemo(() => {
    switch(totalDisplayMode) {
      case 'today': return 'Heute';
      case 'week': return 'Woche';
      case 'month': return 'Monat';
      case 'year': return 'Jahr';
      default: return 'Total';
    }
  }, [totalDisplayMode]);

  const adjustVolume = (id: string, delta: number) => {
    setState(prev => ({
      ...prev,
      loads: prev.loads.map(l => {
        if (l.id === id) {
          const newVol = Math.max(0, parseFloat((l.volume + delta).toFixed(1)));
          return { ...l, volume: newVol };
        }
        return l;
      })
    }));
  };

  const switchTruckForLoad = (loadId: string, newType: TruckType) => {
    setState(prev => {
      const newVolume = newType === TruckType.AXLE_3 ? 10 : 12;
      return {
        ...prev,
        currentTruckType: activeAutoLoadId === loadId ? newType : prev.currentTruckType,
        loads: prev.loads.map(l => l.id === loadId ? { ...l, truckType: newType, volume: newVolume } : l)
      };
    });
  };

  const handleUpdateLoadMaterial = (loadId: string, materialName: string) => {
    setState(prev => ({
      ...prev,
      loads: prev.loads.map(l => l.id === loadId ? { ...l, material: materialName } : l)
    }));
  };

  const handleDeleteLoad = (loadId: string) => {
    setState(prev => ({
      ...prev,
      loads: prev.loads.filter(l => l.id !== loadId)
    }));
    setDeleteConfirmId(null);
  };

  const cancelActiveLoad = () => {
    if (!activeAutoLoadId) return;
    const idToCancel = activeAutoLoadId;
    if (isInLoadingZoneRef.current) {
      hasCanceledCurrentZoneRef.current = isInLoadingZoneRef.current;
    }
    setState(prev => ({
      ...prev,
      loads: prev.loads.filter(l => l.id !== idToCancel)
    }));
    setActiveAutoLoadId(null);
    setShowConfirmCancel(false);
  };

  const finalizeAndPrepareNext = () => {
    setActiveAutoLoadId(null);
    isInLoadingZoneRef.current = null; 
    lastManualResetTimeRef.current = Date.now();
    setShowConfirmCancel(false);
  };

  const handleUpdatePointPos = (siteId: string, pointId: string, lat: number, lon: number) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? {
        ...s,
        loadingPoints: s.loadingPoints.map(p => p.id === pointId ? { ...p, latitude: lat, longitude: lon } : p)
      } : s)
    }));
  };

  const handleUpdatePointRadius = (siteId: string, pointId: string, radius: number) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? {
        ...s,
        loadingPoints: s.loadingPoints.map(p => p.id === pointId ? { ...p, radius } : p)
      } : s)
    }));
  };

  const handleUpdateSitePos = (siteId: string, lat: number, lon: number) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? { ...s, latitude: lat, longitude: lon } : s)
    }));
  };

  const handleUpdateSiteRadius = (siteId: string, radius: number) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? { ...s, radius } : s)
    }));
  };

  const handleRenameSite = (siteId: string, newName: string) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? { ...s, name: newName.toUpperCase() } : s)
    }));
  };

  const handleDeleteSite = (siteId: string) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.filter(s => s.id !== siteId),
      activeSiteId: prev.activeSiteId === siteId ? null : prev.activeSiteId
    }));
    setEditingSite(null);
    setSiteDeleteConfirm(false);
  };

  const handleDeletePoint = (siteId: string, pointId: string) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? {
        ...s,
        loadingPoints: s.loadingPoints.filter(p => p.id !== pointId)
      } : s)
    }));
    setEditingPoint(null);
  };

  const handleChangePointMaterial = (siteId: string, pointId: string, materialName: string) => {
    setState(prev => ({
      ...prev,
      sites: prev.sites.map(s => s.id === siteId ? {
        ...s,
        loadingPoints: s.loadingPoints.map(p => p.id === pointId ? { ...p, material: materialName } : p)
      } : s)
    }));
  };

  const handleCreateSiteAndPoint = (materialName: string) => {
    const coords = pendingPointCoords;
    if (!coords) return;
    const siteIdToUse = state.activeSiteId || crypto.randomUUID();
    const isNewSite = !state.activeSiteId;
    setState(prev => {
      let updatedSites = [...prev.sites];
      if (isNewSite) {
        const newSite: Site = {
          id: siteIdToUse,
          name: (newSiteName || 'Neue Baustelle').toUpperCase(),
          createdAt: Date.now(),
          latitude: coords.lat,
          longitude: coords.lon,
          radius: DEFAULT_SITE_RADIUS,
          loadingPoints: []
        };
        updatedSites.push(newSite);
      }
      const newPoint: LoadingPoint = {
        id: crypto.randomUUID(),
        name: materialName,
        material: materialName,
        latitude: coords.lat,
        longitude: coords.lon,
        radius: LOADING_ZONE_RADIUS_DEFAULT
      };
      return {
        ...prev,
        sites: updatedSites.map(s => s.id === siteIdToUse ? {
          ...s,
          loadingPoints: [...s.loadingPoints, newPoint]
        } : s),
        activeSiteId: siteIdToUse
      };
    });
    setShowMaterialPicker(false);
    setPendingPointCoords(null);
    setNewSiteName('');
  };

  const handleAddCustomMaterial = () => {
    if (!newMaterialName.trim()) return;
    const name = newMaterialName.trim();
    if (state.materials.some(m => m.name.toLowerCase() === name.toLowerCase())) {
        alert("Dieses Material existiert bereits!");
        return;
    }
    const colorIndex = state.materials.length % COLOR_PALETTE.length;
    const newMat: CustomMaterial = {
        id: crypto.randomUUID(),
        name: name,
        colorClass: COLOR_PALETTE[colorIndex]
    };
    setState(prev => ({
        ...prev,
        materials: [...prev.materials, newMat]
    }));
    setNewMaterialName('');
  };

  const handleDeleteMaterial = (id: string) => {
    if (state.materials.length <= 1) return;
    setState(prev => ({
        ...prev,
        materials: prev.materials.filter(m => m.id !== id)
    }));
  };

  const centerMapOnSite = (siteId: string) => {
    const site = state.sites.find(s => s.id === siteId);
    if (site && site.latitude && site.longitude) {
      if (mapRef.current) {
        mapRef.current.flyTo([site.latitude, site.longitude], 17, { duration: 1.5 });
      }
    }
  };

  useEffect(() => {
    if (activeTab === 'track' && state.activeSiteId) {
      const timer = setTimeout(() => centerMapOnSite(state.activeSiteId!), 100);
      return () => clearTimeout(timer);
    }
  }, [state.activeSiteId, activeTab]);

  useEffect(() => {
    if (activeTab === 'track' && mapContainerRef.current && !mapRef.current) {
      if (typeof L === 'undefined') return;
      
      const activeSite = state.sites.find(s => s.id === state.activeSiteId);
      const startLat = activeSite?.latitude || currentCoords?.lat || 51.1657;
      const startLon = activeSite?.longitude || currentCoords?.lon || 10.4515;
      
      mapRef.current = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([startLat, startLon], 16);
      
      markerLayerGroupRef.current = L.layerGroup().addTo(mapRef.current);
      
      mapRef.current.on('dragstart', () => { setAutoCenter(false); });
      mapRef.current.on('click', (e: any) => {
        const clickCoords = { lat: e.latlng.lat, lon: e.latlng.lng };
        setPendingPointCoords(clickCoords);
        const nearbySite = sitesRef.current.find(s => {
          if (!s.latitude || !s.longitude) return false;
          const radius = s.radius || DEFAULT_SITE_RADIUS;
          return calculateDistance(clickCoords.lat, clickCoords.lon, s.latitude, s.longitude) < radius;
        });
        if (nearbySite) {
          setState(prev => ({ ...prev, activeSiteId: nearbySite.id }));
        } else {
          setState(prev => ({ ...prev, activeSiteId: null }));
        }
        setShowMaterialPicker(true);
      });

      setTimeout(() => {
        if (mapRef.current) mapRef.current.invalidateSize();
      }, 300);
    }
    return () => {
      if (mapRef.current && activeTab !== 'track') {
        mapRef.current.remove();
        mapRef.current = null;
        markerLayerGroupRef.current = null;
        tileLayerRef.current = null;
      }
    };
  }, [activeTab]);

  useEffect(() => {
    if (!mapRef.current) return;
    if (tileLayerRef.current) mapRef.current.removeLayer(tileLayerRef.current);
    const url = mapMode === 'standard' 
      ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    const attribution = mapMode === 'satellite' ? 'Tiles &copy; Esri' : '&copy; OpenStreetMap';
    tileLayerRef.current = L.tileLayer(url, { attribution, maxZoom: 19 }).addTo(mapRef.current);
  }, [mapMode, activeTab]);

  useEffect(() => {
    if (!mapRef.current || !markerLayerGroupRef.current) return;
    markerLayerGroupRef.current.clearLayers();
    state.sites.forEach(site => {
      const isActive = state.activeSiteId === site.id;
      if (site.latitude && site.longitude) {
        L.circle([site.latitude, site.longitude], {
          radius: site.radius || DEFAULT_SITE_RADIUS,
          color: isActive ? '#f59e0b' : '#94a3b8',
          fillColor: isActive ? '#fbbf24' : '#cbd5e1',
          fillOpacity: 0.1,
          weight: isActive ? 2 : 1,
          dashArray: '8, 8'
        }).addTo(markerLayerGroupRef.current);
        const siteIcon = L.divIcon({
          className: 'custom-div-icon',
          html: `<div class="w-10 h-10 rounded-xl border-2 border-white shadow-2xl flex items-center justify-center ${isActive ? 'bg-amber-500' : 'bg-slate-700'} text-white transition-all ${!isMapLocked ? 'ring-4 ring-amber-400 ring-offset-2 scale-110' : ''}">
                   <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/></svg>
                 </div>`,
          iconSize: [40, 40],
          iconAnchor: [20, 20]
        });
        const siteMarker = L.marker([site.latitude, site.longitude], {
          icon: siteIcon,
          draggable: !isMapLocked
        }).addTo(markerLayerGroupRef.current);
        siteMarker.on('dragend', (e: any) => {
          const pos = e.target.getLatLng();
          handleUpdateSitePos(site.id, pos.lat, pos.lng);
        });
        siteMarker.on('click', (e: any) => {
          L.DomEvent.stopPropagation(e);
          setState(prev => ({ ...prev, activeSiteId: site.id }));
          setEditingSite(site.id);
          setSiteDeleteConfirm(false);
        });
      }
      site.loadingPoints.forEach(p => {
        const pointRadius = p.radius || LOADING_ZONE_RADIUS_DEFAULT;
        L.circle([p.latitude, p.longitude], { 
          radius: pointRadius, color: '#f59e0b', fillColor: '#fbbf24', fillOpacity: 0.15, weight: 1
        }).addTo(markerLayerGroupRef.current);
        const matColor = getMaterialColor(p.material);
        const icon = L.divIcon({
          className: 'custom-div-icon',
          html: `<div class="w-12 h-12 rounded-full border-4 ${isActive ? 'border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.5)]' : 'border-white'} shadow-2xl flex flex-col items-center justify-center ${matColor} text-white font-black text-[9px] leading-tight transition-all ${!isMapLocked ? 'ring-4 ring-amber-400 ring-offset-2 animate-pulse scale-110' : ''}">
                   <span class="uppercase">${p.material.substring(0,4)}</span>
                 </div>`,
          iconSize: [48, 48],
          iconAnchor: [24, 24]
        });
        const marker = L.marker([p.latitude, p.longitude], { icon, draggable: !isMapLocked, autoPan: true }).addTo(markerLayerGroupRef.current);
        marker.on('dragend', (e: any) => {
          const newPos = e.target.getLatLng();
          handleUpdatePointPos(site.id, p.id, newPos.lat, newPos.lng);
        });
        marker.on('click', (e: any) => {
           L.DomEvent.stopPropagation(e);
           setState(prev => ({ ...prev, activeSiteId: site.id }));
           setEditingPoint({ siteId: site.id, pointId: p.id });
        });
      });
    });
    if (currentCoords) {
      L.circleMarker([currentCoords.lat, currentCoords.lon], { 
        radius: 10, color: '#ffffff', fillColor: '#3b82f6', fillOpacity: 1, weight: 3
      }).addTo(markerLayerGroupRef.current);
    }
  }, [activeTab, state.activeSiteId, state.sites, currentCoords, state.materials, isMapLocked]);

  useEffect(() => {
    let interval: any;
    if (detectionStartTimeRef.current && !activeAutoLoadId) {
      interval = setInterval(() => {
        const elapsed = Date.now() - detectionStartTimeRef.current!;
        const progress = Math.min(100, (elapsed / DETECTION_DELAY_MS) * 100);
        setDetectionProgress(progress);
      }, 100);
    } else {
      setDetectionProgress(0);
    }
    return () => clearInterval(interval);
  }, [activeAutoLoadId]);

  useEffect(() => {
    if (!currentCoords || !state.autoCountEnabled || currentCoords.accuracy > ACCURACY_THRESHOLD) return;
    
    let detectedPoint: { p: LoadingPoint, s: Site } | null = null;
    
    outer: for (const site of state.sites) {
      for (const point of site.loadingPoints) {
        const dist = calculateDistance(currentCoords.lat, currentCoords.lon, point.latitude, point.longitude);
        const pointRadius = point.radius || LOADING_ZONE_RADIUS_DEFAULT;
        if (dist < pointRadius) {
          detectedPoint = { p: point, s: site };
          break outer;
        }
      }
    }

    if (detectedPoint) {
      const dp = detectedPoint;
      if (isInLoadingZoneRef.current !== dp.p.id) {
        if (Date.now() - lastManualResetTimeRef.current > RESET_COOLDOWN_MS) {
          isInLoadingZoneRef.current = dp.p.id;
          if (hasCanceledCurrentZoneRef.current !== dp.p.id) {
            detectionStartTimeRef.current = Date.now();
            detectionTimeoutRef.current = setTimeout(() => {
              const now = Date.now();
              const lastAutoLoad = state.loads
                .filter(l => l.isAutoGenerated && l.loadingPointId === dp.p.id)
                .sort((a,b) => b.timestamp - a.timestamp)[0];
              
              if (!lastAutoLoad || (now - lastAutoLoad.timestamp > 15000)) { 
                setState(prev => ({ ...prev, activeSiteId: dp.s.id }));
                const id = crypto.randomUUID();
                const volume = state.currentTruckType === TruckType.AXLE_3 ? 10 : 12;
                const newLoad: Load = {
                  id, siteId: dp.s.id, loadingPointId: dp.p.id,
                  material: dp.p.material, volume, truckType: state.currentTruckType,
                  timestamp: now, isAutoGenerated: true
                };
                setState(prev => ({ ...prev, loads: [...prev.loads, newLoad] }));
                setActiveAutoLoadId(id);
              }
              detectionStartTimeRef.current = null;
            }, DETECTION_DELAY_MS);
          }
        }
      }
    } else {
      if (detectionTimeoutRef.current) clearTimeout(detectionTimeoutRef.current);
      detectionStartTimeRef.current = null;
      setDetectionProgress(0);
      isInLoadingZoneRef.current = null;
      if (activeAutoLoadId) { setActiveAutoLoadId(null); }
      hasCanceledCurrentZoneRef.current = null; 
    }
  }, [currentCoords, state.autoCountEnabled, state.sites, activeAutoLoadId]);

  const activeLoadData = useMemo(() => activeAutoLoadId ? state.loads.find(l => l.id === activeAutoLoadId) : null, [activeAutoLoadId, state.loads]);
  const activeSiteData = useMemo(() => activeLoadData ? state.sites.find(s => s.id === activeLoadData.siteId) : null, [activeLoadData, state.sites]);
  const editingLoadData = useMemo(() => editingLoadId ? state.loads.find(l => l.id === editingLoadId) : null, [editingLoadId, state.loads]);
  const editingPointData = useMemo(() => {
    if (!editingPoint) return null;
    const site = state.sites.find(s => s.id === editingPoint.siteId);
    return site?.loadingPoints.find(p => p.id === editingPoint.pointId) || null;
  }, [editingPoint, state.sites]);

  const sortedLoads = useMemo(() => [...state.loads].sort((a,b) => b.timestamp - a.timestamp), [state.loads]);

  const filteredHistoryLoads = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(now.getDate() - 1);
    const startOfYesterday = new Date(yesterdayDate.getFullYear(), yesterdayDate.getMonth(), yesterdayDate.getDate()).getTime();
    const endOfYesterday = startOfToday - 1;
    
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startOfWeek = new Date(new Date(now).setDate(diff)).setHours(0,0,0,0);

    return sortedLoads.filter(load => {
      if (historyFilter === 'all') return true;
      if (historyFilter === 'today') return load.timestamp >= startOfToday;
      if (historyFilter === 'yesterday') return load.timestamp >= startOfYesterday && load.timestamp <= endOfYesterday;
      if (historyFilter === 'week') return load.timestamp >= startOfWeek;
      return true;
    });
  }, [sortedLoads, historyFilter]);

  const filteredStatsBySite = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startOfWeek = new Date(new Date(now).setDate(diff)).setHours(0,0,0,0);

    const filterFn = (load: Load) => {
      if (statsFilter === 'all') return true;
      if (statsFilter === 'today') return load.timestamp >= startOfToday;
      if (statsFilter === 'week') return load.timestamp >= startOfWeek;
      if (statsFilter === 'day') {
        const startOfSelected = new Date(selectedStatsDate).setHours(0,0,0,0);
        const endOfSelected = new Date(selectedStatsDate).setHours(23,59,59,999);
        return load.timestamp >= startOfSelected && load.timestamp <= endOfSelected;
      }
      return true;
    };
    const siteStats: Record<string, { name: string, materials: Record<string, { volume: number, count: number }> }> = {};
    state.sites.forEach(s => {
      siteStats[s.id] = { name: s.name, materials: {} };
      state.materials.forEach(m => siteStats[s.id].materials[m.name] = { volume: 0, count: 0 });
    });
    state.loads.filter(filterFn).forEach(load => {
      if (siteStats[load.siteId]) {
        if (!siteStats[load.siteId].materials[load.material]) {
            siteStats[load.siteId].materials[load.material] = { volume: 0, count: 0 };
        }
        siteStats[load.siteId].materials[load.material].volume += load.volume;
        siteStats[load.siteId].materials[load.material].count += 1;
      }
    });
    return Object.fromEntries(
      Object.entries(siteStats).filter(([_, data]) => 
        Object.values(data.materials).some(m => m.count > 0)
      )
    ) as any;
  }, [state.loads, state.sites, statsFilter, selectedStatsDate, state.materials]);

  const TabButton = ({ id, icon: Icon, label }: { id: typeof activeTab, icon: any, label: string }) => (
    <button 
      onClick={() => setActiveTab(id)}
      className={`flex flex-col items-center justify-center py-3 gap-1 transition-colors ${activeTab === id ? 'text-amber-600' : 'text-slate-400'}`}
    >
      <Icon className="w-5 h-5" />
      <span className="text-[10px] font-bold uppercase">{label}</span>
    </button>
  );

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 relative shadow-xl overflow-hidden text-slate-900">
      
      {locationError && activeTab === 'track' && (
        <div className="fixed top-24 left-4 right-4 z-[4000] bg-red-600 text-white p-4 rounded-2xl shadow-xl border-2 border-white animate-in slide-in-from-top-4">
           <div className="flex items-center justify-between gap-3">
             <div className="flex items-center gap-3">
               <Icons.MapPin className="w-6 h-6 animate-pulse" />
               <div>
                 <p className="text-[10px] font-black uppercase tracking-widest leading-none mb-1">GPS FEHLER</p>
                 <p className="text-xs font-bold leading-tight">{locationError}</p>
               </div>
             </div>
             <button 
               onClick={handleGpsRetry}
               className="bg-white text-red-600 px-3 py-2 rounded-xl text-[10px] font-black uppercase shadow-lg active:scale-95 transition-transform shrink-0"
             >
               Erneut prüfen
             </button>
           </div>
        </div>
      )}

      {detectionProgress > 0 && !activeAutoLoadId && (
        <div className="fixed top-24 left-4 right-4 z-[4000] bg-white/90 backdrop-blur-md p-4 rounded-2xl shadow-xl border border-amber-200 animate-in fade-in slide-in-from-top-4">
           <div className="flex items-center gap-3 mb-2">
             <div className="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center text-white">
               <Icons.Truck className="w-5 h-5 animate-pulse" />
             </div>
             <div className="flex-1">
               <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest leading-none">Bagger erkannt</p>
               <p className="text-xs font-bold text-slate-800 uppercase">Beladung wird vorbereitet...</p>
             </div>
           </div>
           <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
             <div className="h-full bg-amber-500 transition-all duration-100 ease-linear" style={{ width: `${detectionProgress}%` }}></div>
           </div>
        </div>
      )}

      {editingLoadData && (
        <div className="fixed inset-0 z-[5000] flex flex-col justify-end p-6 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white w-full rounded-[3rem] shadow-2xl overflow-hidden border-4 border-slate-900 animate-in slide-in-from-bottom-10 duration-300">
            <div className="bg-slate-900 p-6 text-white">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-xl font-black italic uppercase text-amber-500">FUHRE BEARBEITEN</h2>
                  <p className="text-[10px] font-bold uppercase opacity-60 tracking-widest leading-tight">Nachträgliche Korrektur</p>
                </div>
                <Icons.Edit className="w-8 h-8 text-amber-500" />
              </div>
            </div>
            <div className="p-8 space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Material ändern</span>
                  <div className="flex flex-wrap gap-2">
                    {state.materials.map(m => (
                        <button 
                            key={m.id} 
                            onClick={() => handleUpdateLoadMaterial(editingLoadId!, m.name)}
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase transition-all ${editingLoadData.material === m.name ? `${m.colorClass} text-white shadow-md` : 'bg-slate-50 text-slate-400 border border-slate-200'}`}
                        >
                            {m.name}
                        </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Fahrzeugtyp</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => switchTruckForLoad(editingLoadId!, TruckType.AXLE_3)} className={`py-2 rounded-xl text-[10px] font-black uppercase border-2 transition-all ${editingLoadData.truckType === TruckType.AXLE_3 ? `${getMaterialColor(editingLoadData.material)} border-transparent text-white shadow-lg` : 'bg-slate-50 border-slate-200 text-slate-400'}`}>3-Achser (10m³)</button>
                    <button onClick={() => switchTruckForLoad(editingLoadId!, TruckType.AXLE_4)} className={`py-2 rounded-xl text-[10px] font-black uppercase border-2 transition-all ${editingLoadData.truckType === TruckType.AXLE_4 ? `${getMaterialColor(editingLoadData.material)} border-transparent text-white shadow-lg` : 'bg-slate-50 border-slate-200 text-slate-400'}`}>4-Achser (12m³)</button>
                  </div>
                </div>
              </div>
              <div className="bg-slate-50 p-6 rounded-[2.5rem] border-2 border-slate-100">
                <p className="text-center text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Menge korrigieren</p>
                <div className="flex items-center justify-between">
                  <button onClick={() => adjustVolume(editingLoadId!, -0.5)} className="w-14 h-14 rounded-2xl bg-white shadow-md flex items-center justify-center active:scale-90 transition-transform border border-slate-200"><span className="text-3xl font-black text-slate-900">-</span></button>
                  <div className="text-center"><span className="text-6xl font-black italic text-slate-900">{editingLoadData.volume.toFixed(1)}</span><span className={`text-lg font-black ml-1 uppercase italic ${getMaterialColor(editingLoadData.material).replace('bg-', 'text-')}`}>m³</span></div>
                  <button onClick={() => adjustVolume(editingLoadId!, 0.5)} className="w-14 h-14 rounded-2xl bg-white shadow-md flex items-center justify-center active:scale-90 transition-transform border border-slate-200"><span className="text-3xl font-black text-slate-900">+</span></button>
                </div>
              </div>
              <div className="pt-2">
                <button onClick={() => setEditingLoadId(null)} className={`w-full py-5 rounded-2xl ${getMaterialColor(editingLoadData.material)} text-white font-black uppercase text-base shadow-xl flex items-center justify-center gap-3 active:scale-95 transition-all border-b-4 border-black/20`}>Änderungen Speichern</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeLoadData && (
        <div className="fixed inset-0 z-[5000] flex flex-col justify-end p-6 bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white w-full rounded-[3rem] shadow-2xl overflow-hidden border-4 border-amber-500 animate-in slide-in-from-bottom-10 duration-300">
            <div className="bg-slate-900 p-6 text-white">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-xl font-black italic uppercase text-amber-500">BELADUNG AKTIV</h2>
                  <p className="text-[10px] font-bold uppercase opacity-60 tracking-widest leading-tight">LKW wird beladen</p>
                </div>
                <Icons.Truck className="w-8 h-8 text-amber-500 animate-bounce" />
              </div>
              <div className="bg-slate-800 p-3 rounded-2xl border border-slate-700 flex items-center gap-3">
                <Icons.Building className="w-4 h-4 text-amber-500" />
                <div className="flex-1">
                  <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest leading-none mb-1">Baustelle benennen</p>
                  <input type="text" value={activeSiteData?.name || ''} onChange={(e) => handleRenameSite(activeLoadData.siteId, e.target.value)} placeholder="NAME EINGEBEN..." className="w-full bg-transparent border-none text-white font-black uppercase text-sm outline-none focus:text-amber-400 placeholder:text-slate-600" />
                </div>
                <Icons.Edit className="w-3 h-3 text-slate-600" />
              </div>
            </div>
            <div className="p-8 space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Material korrigieren</span>
                  <div className="flex flex-wrap gap-2">
                    {state.materials.map(m => (
                      <button 
                        key={m.id} 
                        onClick={() => handleUpdateLoadMaterial(activeAutoLoadId!, m.name)}
                        className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase transition-all ${activeLoadData.material === m.name ? `${m.colorClass} text-white shadow-md ring-2 ring-white ring-offset-1` : 'bg-slate-50 text-slate-400 border border-slate-200'}`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Fahrzeug wechseln</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => switchTruckForLoad(activeAutoLoadId!, TruckType.AXLE_3)} className={`py-2 rounded-xl text-[10px] font-black uppercase border-2 transition-all ${activeLoadData.truckType === TruckType.AXLE_3 ? `${getMaterialColor(activeLoadData.material)} border-transparent text-white shadow-lg` : 'bg-slate-50 border-slate-200 text-slate-400'}`}>3-Achser (10m³)</button>
                    <button onClick={() => switchTruckForLoad(activeAutoLoadId!, TruckType.AXLE_4)} className={`py-2 rounded-xl text-[10px] font-black uppercase border-2 transition-all ${activeLoadData.truckType === TruckType.AXLE_4 ? `${getMaterialColor(activeLoadData.material)} border-transparent text-white shadow-lg` : 'bg-slate-50 border-slate-200 text-slate-400'}`}>4-Achser (12m³)</button>
                  </div>
                </div>
              </div>
              <div className="bg-slate-50 p-6 rounded-[2.5rem] border-2 border-slate-100">
                <p className="text-center text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Menge korrigieren</p>
                <div className="flex items-center justify-between">
                  <button onClick={() => adjustVolume(activeAutoLoadId!, -0.5)} className="w-14 h-14 rounded-2xl bg-white shadow-md flex items-center justify-center active:scale-90 transition-transform border border-slate-200"><span className="text-3xl font-black text-slate-900">-</span></button>
                  <div className="text-center"><span className="text-6xl font-black italic text-slate-900">{activeLoadData.volume.toFixed(1)}</span><span className={`text-lg font-black ml-1 uppercase italic ${getMaterialColor(activeLoadData.material).replace('bg-', 'text-')}`}>m³</span></div>
                  <button onClick={() => adjustVolume(activeAutoLoadId!, 0.5)} className="w-14 h-14 rounded-2xl bg-white shadow-md flex items-center justify-center active:scale-90 transition-transform border border-slate-200"><span className="text-3xl font-black text-slate-900">+</span></button>
                </div>
              </div>
              
              <div className="pt-2 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => setActiveAutoLoadId(null)} className="py-5 rounded-2xl bg-slate-100 text-slate-600 font-black uppercase text-sm shadow-lg active:scale-95 transition-all border-b-4 border-slate-300 flex items-center justify-center gap-2"><Icons.Globe className="w-5 h-5" /> ZU KARTE</button>
                  <button onClick={finalizeAndPrepareNext} className={`py-5 rounded-2xl ${getMaterialColor(activeLoadData.material)} text-white font-black uppercase text-sm shadow-lg active:scale-95 transition-all border-b-4 border-black/20 flex items-center justify-center gap-2`}><Icons.Plus className="w-5 h-5" /> FERTIG</button>
                </div>
                <div className="relative">
                  {!showConfirmCancel ? (
                    <button onClick={() => setShowConfirmCancel(true)} className="w-full py-4 rounded-xl bg-red-100 text-red-700 font-black uppercase text-[10px] border border-red-200 active:scale-95 transition-all flex items-center justify-center gap-2 shadow-sm"><Icons.Trash className="w-4 h-4" /> Fuhre abbrechen (löschen)</button>
                  ) : (
                    <div className="flex gap-2 animate-in zoom-in-95 duration-200">
                       <button onClick={() => setShowConfirmCancel(false)} className="flex-1 py-4 rounded-xl bg-slate-100 text-slate-600 font-black uppercase text-[10px] border border-slate-200">Abbrechen</button>
                      <button onClick={cancelActiveLoad} className="flex-[2] py-4 rounded-xl bg-red-600 text-white font-black uppercase text-[10px] border-b-4 border-red-800 shadow-xl flex items-center justify-center gap-2"><Icons.Trash className="w-4 h-4" /> JA, DIESE FUHRE LÖSCHEN!</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <header className="bg-slate-900 text-white p-4 pt-12 sticky top-0 z-[1100] shadow-xl border-b border-slate-800 shrink-0">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <Icons.Logo className="w-10 h-10 drop-shadow-lg" />
            <div>
              <h1 className="text-xl font-black italic text-amber-500 tracking-tighter leading-none">KIPPERLOG</h1>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-black text-white uppercase tracking-[0.3em] opacity-80">PRO</span>
                {state.stayAwake && <div className="animate-pulse bg-green-500 w-1.5 h-1.5 rounded-full" title="Wach-Modus aktiv"></div>}
              </div>
            </div>
          </div>
          <button 
            onClick={cycleTotalDisplay}
            className="text-right group active:scale-95 transition-transform bg-slate-800/50 px-4 py-2 rounded-2xl border border-slate-700 hover:border-amber-500"
          >
            <span className="text-2xl font-black text-white">{summaryVolume.toFixed(1)}</span>
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-[10px] block text-amber-500 font-black uppercase leading-none">{totalLabel}</span>
              <Icons.History className="w-2.5 h-2.5 text-slate-500 group-hover:text-amber-500" />
            </div>
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pb-24 relative bg-slate-100 min-h-0">
        {activeTab === 'track' && (
          <div className="h-full w-full flex flex-col relative">
            <div className="absolute inset-0 z-[10]">
              <div ref={mapContainerRef} className="h-full w-full"></div>
            </div>

            {currentCoords && (
                <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[1005]">
                    <div className={`px-4 py-1.5 rounded-full backdrop-blur-md border shadow-lg text-[9px] font-black uppercase tracking-wider flex items-center gap-2 ${currentCoords.accuracy > ACCURACY_THRESHOLD ? 'bg-red-500/80 border-red-400 text-white animate-pulse' : 'bg-white/80 border-slate-200 text-slate-600'}`}>
                        <Icons.MapPin className="w-3 h-3" />
                        <span>Genauigkeit: {Math.round(currentCoords.accuracy)}m {currentCoords.accuracy > ACCURACY_THRESHOLD ? '(STÖRSIGNAL)' : ''}</span>
                    </div>
                </div>
            )}

            <div className="absolute top-4 right-4 z-[1005] flex flex-col gap-2">
              <button 
                onClick={() => setIsMapLocked(!isMapLocked)} 
                className={`p-3 rounded-2xl shadow-2xl active:scale-95 transition-transform flex flex-col items-center justify-center min-w-[75px] border-2 ${!isMapLocked ? 'bg-amber-500 border-white text-white animate-pulse' : 'bg-white border-slate-200 text-slate-600'}`}
              >
                {isMapLocked ? <Icons.Lock className="w-5 h-5 mb-1" /> : <Icons.Unlock className="w-5 h-5 mb-1" />}
                <span className="text-[8px] font-black uppercase">{isMapLocked ? 'GESPERRT' : 'BEARBEITEN'}</span>
              </button>
              <button onClick={() => setState(prev => ({...prev, currentTruckType: prev.currentTruckType === TruckType.AXLE_3 ? TruckType.AXLE_4 : TruckType.AXLE_3}))} className="bg-slate-900 text-white p-3 rounded-2xl shadow-2xl active:scale-95 transition-transform flex flex-col items-center justify-center min-w-[75px] border border-slate-700">
                <Icons.Truck className="w-5 h-5 text-amber-500 mb-1" /><span className="text-[8px] font-black">{state.currentTruckType.includes('10') ? '3-ACHSER' : '4-ACHSER'}</span>
              </button>
              <button onClick={() => setMapMode(mapMode === 'standard' ? 'satellite' : 'standard')} className={`p-3 rounded-2xl shadow-2xl active:scale-95 transition-transform flex flex-col items-center justify-center min-w-[75px] border ${mapMode === 'satellite' ? 'bg-amber-500 border-amber-600 text-white' : 'bg-white border-slate-200 text-slate-600'}`}>
                <Icons.Globe className={`w-5 h-5 mb-1 ${mapMode === 'satellite' ? 'text-white' : 'text-slate-600'}`} /><span className="text-[8px] font-black uppercase">{mapMode === 'satellite' ? 'Karte' : 'Satellit'}</span>
              </button>
              <button onClick={() => setAutoCenter(!autoCenter)} className={`p-3 rounded-2xl shadow-2xl active:scale-95 transition-transform flex flex-col items-center justify-center min-w-[75px] border ${autoCenter ? 'bg-blue-500 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-400'}`}>
                <Icons.MapPin className={`w-5 h-5 mb-1 ${autoCenter ? 'text-white' : 'text-slate-400'}`} /><span className="text-[8px] font-black uppercase">GPS</span>
              </button>
            </div>
            {!isOnline && (
                <div className="absolute top-4 left-4 z-[1005]">
                    <div className="bg-red-600 text-white px-3 py-1.5 rounded-xl shadow-xl text-[10px] font-black uppercase animate-pulse border-2 border-white">Offline-Modus</div>
                </div>
            )}
            <div className="absolute bottom-6 left-4 right-4 z-[1005]">
                <div className={`p-3 rounded-2xl backdrop-blur-sm text-center shadow-lg border transition-all ${!isMapLocked ? 'bg-amber-600/90 text-white border-white scale-105' : 'bg-white/90 text-slate-800 border-slate-200'}`}>
                    <p className="text-[10px] font-black uppercase tracking-widest leading-tight">
                        {!isMapLocked ? 'Symbol ziehen zum Verschieben' : 'Auf Karte tippen, um Bagger zu setzen'}
                    </p>
                </div>
            </div>
          </div>
        )}

        {editingSite && (
          <div className="fixed inset-0 z-[4500] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-6">
            <div className="bg-white rounded-[2rem] p-8 space-y-6 w-full max-w-sm shadow-2xl border-4 border-amber-500">
               <h3 className="text-xl font-black italic uppercase text-slate-900 flex items-center gap-2"><Icons.Building className="text-amber-500" /> Baustelle verwalten</h3>
               <div className="space-y-4">
                 <div className="space-y-1">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Name ändern</label>
                   <input defaultValue={state.sites.find(s => s.id === editingSite)?.name} onBlur={(e) => handleRenameSite(editingSite, e.target.value)} placeholder="NAME..." className="w-full bg-slate-100 p-4 rounded-2xl font-black text-lg uppercase outline-none focus:ring-4 focus:ring-amber-500/20" />
                 </div>
                 <div className="space-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-100">
                   <div className="flex justify-between items-center">
                     <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Baustellen-Radius</label>
                     <span className="text-sm font-black text-amber-600 bg-amber-50 px-3 py-1 rounded-lg">{(state.sites.find(s => s.id === editingSite)?.radius || DEFAULT_SITE_RADIUS)}m</span>
                   </div>
                   <input type="range" min="50" max="1000" step="10" value={state.sites.find(s => s.id === editingSite)?.radius || DEFAULT_SITE_RADIUS} onChange={(e) => handleUpdateSiteRadius(editingSite, parseInt(e.target.value))} className="w-full h-3 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                   <div className="flex justify-between text-[8px] font-black text-slate-400 uppercase"><span>50m</span><span>500m</span><span>1000m</span></div>
                 </div>
               </div>
               <div className="grid grid-cols-1 gap-2 pt-4">
                 <button onClick={() => { setEditingSite(null); setSiteDeleteConfirm(false); }} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase text-sm">Fertig</button>
                 <div className="pt-2">
                   {!siteDeleteConfirm ? (
                     <button onClick={() => setSiteDeleteConfirm(true)} className="w-full py-4 text-red-500 font-black uppercase text-xs flex items-center justify-center gap-2"><Icons.Trash className="w-4 h-4"/> Baustelle löschen</button>
                   ) : (
                     <div className="flex flex-col gap-2 animate-in zoom-in-95 duration-200">
                        <button onClick={() => setSiteDeleteConfirm(false)} className="w-full py-3 bg-slate-100 text-slate-600 font-black uppercase text-[10px] rounded-xl">Abbrechen</button>
                        <button onClick={() => handleDeleteSite(editingSite)} className="w-full py-4 bg-red-600 text-white font-black uppercase text-xs rounded-xl shadow-xl border-b-4 border-red-800 flex items-center justify-center gap-2"><Icons.Trash className="w-4 h-4" /> JA, ENDGÜLTIG LÖSCHEN!</button>
                     </div>
                   )}
                 </div>
               </div>
            </div>
          </div>
        )}

        {editingPoint && editingPointData && (
          <div className="fixed inset-0 z-[4500] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-6">
            <div className="bg-white rounded-[2rem] p-8 space-y-6 w-full max-w-sm shadow-2xl border-4 border-amber-500 overflow-y-auto max-h-[90vh]">
              <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-xl font-black italic uppercase text-slate-900">Bagger verwalten</h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-none mt-1">Einstellungen anpassen</p>
                  </div>
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-white ${getMaterialColor(editingPointData.material)} shadow-lg`}>
                      <Icons.Truck className="w-6 h-6" />
                  </div>
              </div>

              <div className="space-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Bagger-Radius (Fangbereich)</label>
                  <span className="text-sm font-black text-amber-600 bg-amber-50 px-3 py-1 rounded-lg">{(editingPointData.radius || LOADING_ZONE_RADIUS_DEFAULT)}m</span>
                </div>
                <input 
                  type="range" min="10" max="150" step="5" 
                  value={editingPointData.radius || LOADING_ZONE_RADIUS_DEFAULT} 
                  onChange={(e) => handleUpdatePointRadius(editingPoint.siteId, editingPoint.pointId, parseInt(e.target.value))} 
                  className="w-full h-3 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-amber-500" 
                />
                <div className="flex justify-between text-[8px] font-black text-slate-400 uppercase"><span>10m (Präzise)</span><span>150m (Groß)</span></div>
                <p className="text-[9px] text-slate-400 font-medium italic mt-1 leading-tight">Tipp: Bei schlechtem Signal (GPS-Drift) Radius etwas größer stellen.</p>
              </div>

              <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Material ändern</label>
                 <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                  {state.materials.map(m => (
                    <button 
                      key={m.id} 
                      onClick={() => handleChangePointMaterial(editingPoint.siteId, editingPoint.pointId, m.name)} 
                      className={`w-full p-4 rounded-xl text-white font-black text-sm text-left flex justify-between items-center transition-all ${m.name === editingPointData.material ? `${m.colorClass} shadow-lg scale-[1.02] border-2 border-white` : 'bg-slate-300 opacity-60'}`}
                    >
                      <span>{m.name.toUpperCase()}</span>
                      {m.name === editingPointData.material && <div className="w-2 h-2 rounded-full bg-white animate-pulse"></div>}
                    </button>
                  ))}
                 </div>
              </div>

              <div className="grid grid-cols-1 gap-2 pt-2">
                <button onClick={() => setEditingPoint(null)} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase text-sm shadow-lg active:scale-95 transition-all">Fertig</button>
                <button onClick={() => handleDeletePoint(editingPoint.siteId, editingPoint.pointId)} className="w-full py-4 text-red-500 font-black uppercase text-xs flex items-center justify-center gap-2 hover:bg-red-50 rounded-xl transition-colors"><Icons.Trash className="w-4 h-4"/> Bagger entfernen</button>
              </div>
            </div>
          </div>
        )}

        {showMaterialPicker && (
          <div className="fixed inset-0 z-[4000] bg-slate-900/95 backdrop-blur-md flex flex-col justify-end p-4">
            <div className="bg-white rounded-[2.5rem] p-8 space-y-6 max-w-md mx-auto w-full shadow-2xl">
              <div className="flex justify-between items-center"><h3 className="text-2xl font-black italic uppercase text-slate-900">{state.activeSiteId ? 'Neuer Bagger' : 'Neue Baustelle'}</h3><button onClick={() => {setShowMaterialPicker(false); setPendingPointCoords(null);}} className="text-slate-300"><Icons.Plus className="rotate-45 w-8 h-8" /></button></div>
              {!state.activeSiteId && (
                <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Name der neuen Baustelle</label>
                  <input autoFocus type="text" value={newSiteName} onChange={e => setNewSiteName(e.target.value)} placeholder="Z.B. HAUPTSTRASSE..." className="w-full bg-slate-100 p-5 rounded-2xl text-lg font-black uppercase outline-none border-2 border-transparent focus:border-amber-500" />
                </div>
              )}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Material für Bagger wählen</label>
                <div className="grid grid-cols-1 gap-2 max-h-[40vh] overflow-y-auto pr-1">
                  {state.materials.map(m => (
                    <button key={m.id} onClick={() => handleCreateSiteAndPoint(m.name)} className={`w-full p-5 rounded-2xl text-white font-black text-lg text-left flex justify-between items-center shadow-md active:scale-95 transition-transform ${m.colorClass}`}><span>{m.name.toUpperCase()}</span><Icons.Plus className="w-6 h-6" /></button>
                  ))}
                </div>
              </div>
              <button onClick={() => {setShowMaterialPicker(false); setPendingPointCoords(null);}} className="w-full py-2 text-slate-400 font-bold uppercase text-xs">Abbrechen</button>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="p-4 space-y-4">
            <h2 className="text-2xl font-black italic uppercase tracking-tighter">Verlauf</h2>
            <div className="sticky top-0 z-[1050] bg-slate-100/80 backdrop-blur-md -mx-4 px-4 py-2 border-b border-slate-200">
              <div className="flex bg-slate-200 p-1 rounded-2xl gap-1">
                {[{ id: 'today', label: 'Heute' }, { id: 'yesterday', label: 'Gestern' }, { id: 'week', label: 'Woche' }, { id: 'all', label: 'Alle' }].map(f => (
                  <button key={f.id} onClick={() => setHistoryFilter(f.id as any)} className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all ${historyFilter === f.id ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-500'}`}>{f.label}</button>
                ))}
              </div>
            </div>
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              {filteredHistoryLoads.map(load => (
                <div key={load.id} className="bg-white p-4 rounded-2xl shadow-sm flex justify-between items-center border border-slate-200">
                  <div className="flex-1">
                    <div className="flex gap-2 mb-1"><span className={`text-[8px] font-black text-white px-2 py-0.5 rounded uppercase mb-1 ${getMaterialColor(load.material)}`}>{load.material}</span></div>
                    <p className="font-black text-slate-800 uppercase text-xs truncate">{state.sites.find(s => s.id === load.siteId)?.name || 'Gelöscht'}</p>
                    <p className="text-[10px] text-slate-400 font-bold">{new Date(load.timestamp).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="text-right mr-3"><p className="text-xl font-black text-amber-600 leading-none">{load.volume.toFixed(1)} m³</p></div>
                    {deleteConfirmId === load.id ? (
                      <div className="flex gap-1 animate-in slide-in-from-right-2 duration-200">
                         <button onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(null); }} className="px-3 py-3 bg-slate-100 text-slate-400 rounded-xl text-[10px] font-black uppercase">Abbr.</button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteLoad(load.id); }} className="px-4 py-3 bg-red-600 text-white rounded-xl text-[10px] font-black uppercase shadow-lg shadow-red-200">Löschen?</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button onClick={(e) => { e.stopPropagation(); setEditingLoadId(load.id); }} className="p-4 text-slate-400 hover:text-slate-900 active:bg-slate-50 rounded-xl transition-colors" title="Bearbeiten"><Icons.Edit className="w-6 h-6"/></button>
                        <button onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(load.id); }} className="p-4 text-slate-300 hover:text-red-500 active:bg-red-50 rounded-xl transition-colors" title="Löschen"><Icons.Trash className="w-6 h-6"/></button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {filteredHistoryLoads.length === 0 && (
                <div className="text-center py-20 bg-white rounded-[3rem] border-2 border-dashed border-slate-200">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-200"><Icons.History className="w-8 h-8" /></div>
                  <p className="text-slate-400 font-black uppercase text-[10px] tracking-widest">Keine Fuhren in diesem Zeitraum</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'stats' && (
          <div className="p-4 space-y-4">
            <h2 className="text-2xl font-black italic uppercase tracking-tighter">Mengen-Statistik</h2>
            <div className="sticky top-0 z-[1050] bg-slate-100 pb-2 space-y-2">
              <div className="flex bg-slate-200 p-1 rounded-2xl overflow-x-auto gap-1 no-scrollbar">
                {[{ id: 'today', label: 'Heute' }, { id: 'week', label: 'Woche' }, { id: 'day', label: 'Datum' }, { id: 'all', label: 'Alle' }].map(f => (
                  <button key={f.id} onClick={() => setStatsFilter(f.id as any)} className={`flex-1 min-w-[70px] py-2.5 rounded-xl text-[10px] font-black uppercase transition-all ${statsFilter === f.id ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-500'}`}>{f.label}</button>
                ))}
              </div>
              {statsFilter === 'day' && (
                <div className="animate-in slide-in-from-top-2 duration-200">
                  <div className="bg-white p-3 rounded-2xl border border-slate-200 flex items-center gap-3">
                    <input type="date" value={selectedStatsDate} onChange={(e) => setSelectedStatsDate(e.target.value)} className="flex-1 bg-transparent border-none text-sm font-black uppercase outline-none" />
                    <Icons.History className="w-4 h-4 text-slate-300" />
                  </div>
                </div>
              )}
            </div>
            {Object.entries(filteredStatsBySite).length > 0 ? (
              <div className="space-y-6 animate-in fade-in duration-300">
                {Object.entries(filteredStatsBySite).map(([siteId, siteData]: [string, any]) => (
                  <div key={siteId} className="bg-white rounded-[2rem] shadow-md overflow-hidden border border-slate-200">
                    <div className="bg-slate-900 p-5 text-white flex justify-between items-center"><h3 className="font-black uppercase italic tracking-widest truncate">{siteData.name}</h3></div>
                    <div className="p-5 space-y-3">
                      {Object.entries(siteData.materials).map(([mat, data]: [string, any]) => data.count > 0 ? (
                        <div key={mat} className="flex justify-between items-center border-b border-slate-50 pb-3">
                          <div>
                            <span className={`inline-block text-[8px] font-black text-white px-2 py-0.5 rounded uppercase mb-1 ${getMaterialColor(mat)}`}>{mat}</span>
                            <p className="text-sm font-black text-slate-700">{data.count} Fuhren</p>
                          </div>
                          <div className="text-right"><p className="text-xl font-black text-amber-600 leading-none">{data.volume.toFixed(1)} m³</p></div>
                        </div>
                      ) : null)}
                    </div>
                    <div className="bg-slate-50 p-4 text-right border-t border-slate-100"><span className="text-[10px] font-black text-slate-400 uppercase mr-2">Zeitraum Summe:</span><span className="text-xl font-black text-slate-900 italic">{Object.values(siteData.materials as Record<string, any>).reduce((s: number, d: any) => s + d.volume, 0).toFixed(1)} m³</span></div>
                  </div>
                ))}
                <div className="bg-amber-500 p-6 rounded-[2.5rem] text-white shadow-xl">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-80 mb-1">Gesamtleistung Zeitraum</p>
                    <div className="flex justify-between items-end">
                        <span className="text-4xl font-black italic">{Object.values(filteredStatsBySite as Record<string, any>).reduce((acc: number, site: any) => acc + Object.values(site.materials as Record<string, any>).reduce((s: number, d: any) => s + d.volume, 0), 0).toFixed(1)} m³</span>
                        <span className="text-sm font-black uppercase opacity-80">{Object.values(filteredStatsBySite as Record<string, any>).reduce((acc: number, site: any) => acc + Object.values(site.materials as Record<string, any>).reduce((s: number, d: any) => s + d.count, 0), 0)} Fuhren</span>
                    </div>
                </div>
              </div>
            ) : (
              <div className="bg-white p-12 rounded-[3rem] text-center border-2 border-dashed border-slate-200">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300"><Icons.Chart className="w-8 h-8" /></div>
                <h4 className="text-slate-900 font-black uppercase text-sm mb-1">Keine Daten gefunden</h4>
                <p className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">In diesem Zeitraum wurden keine Fuhren erfasst.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-4 space-y-6">
            <h2 className="text-2xl font-black italic uppercase tracking-tighter">System</h2>
            
            <section className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 space-y-4">
              <div className="flex items-center gap-3 mb-2"><Icons.History className="w-5 h-5 text-amber-500" /><p className="font-black text-slate-800 uppercase text-sm">Speicher-Status</p></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Fuhren</p>
                    <p className="text-2xl font-black text-slate-900">{state.loads.length}</p>
                </div>
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Baustellen</p>
                    <p className="text-2xl font-black text-slate-900">{state.sites.length}</p>
                </div>
              </div>
            </section>

            <section className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-black text-slate-800 uppercase text-sm">Bildschirm immer an</p>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Verhindert Standby im LKW</p>
                </div>
                <button onClick={() => setState(p => ({...p, stayAwake: !p.stayAwake}))} className={`w-14 h-8 rounded-full p-1 transition-all ${state.stayAwake ? 'bg-amber-500' : 'bg-slate-300'}`}><div className={`w-6 h-6 rounded-full bg-white shadow-xl transition-transform ${state.stayAwake ? 'translate-x-6' : 'translate-x-0'}`}></div></button>
              </div>
            </section>

            <section className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-black text-slate-800 uppercase text-sm">Material-Verwaltung</p>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Eigene Materialien anlegen</p>
                </div>
                <button onClick={() => setShowMaterialManager(true)} className="bg-slate-900 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase">Anpassen</button>
              </div>
            </section>

            <section className="bg-amber-50 p-6 rounded-[2rem] border border-amber-100 space-y-3">
               <div className="flex items-center gap-3"><Icons.Globe className="text-amber-600 w-5 h-5" /><h4 className="font-black uppercase text-xs text-amber-800">Profi-Tipp für Hintergrund-Tracking</h4></div>
               <p className="text-[10px] text-amber-700 font-medium leading-relaxed uppercase">Damit die App auch trackt, wenn du WhatsApp öffnest, deaktiviere die <b>„Akku-Optimierung“</b> für diese Seite.</p>
            </section>
            
            <button onClick={() => {if(confirm('App komplett zurücksetzen? Alle Fuhren werden gelöscht!')){localStorage.clear(); window.location.reload();}}} className="w-full p-5 text-red-500 font-black text-sm border-2 border-red-50 rounded-2xl uppercase italic tracking-widest">Werkseinstellung (Löschen)</button>
          </div>
        )}
      </main>

      {showMaterialManager && (
        <div className="fixed inset-0 z-[5000] bg-slate-900/90 backdrop-blur-md flex flex-col justify-end p-4">
           <div className="bg-white rounded-[2.5rem] p-8 space-y-6 w-full max-w-md mx-auto shadow-2xl animate-in slide-in-from-bottom-10">
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-black italic uppercase text-slate-900">Materialien verwalten</h3>
                <button onClick={() => setShowMaterialManager(false)} className="text-slate-300"><Icons.Plus className="rotate-45 w-8 h-8" /></button>
              </div>
              
              <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                {state.materials.map(m => (
                    <div key={m.id} className="flex items-center gap-3 bg-slate-50 p-3 rounded-2xl border border-slate-100">
                        <div className={`w-8 h-8 rounded-lg ${m.colorClass} shadow-sm`}></div>
                        <span className="flex-1 font-black uppercase text-sm">{m.name}</span>
                        <button onClick={() => handleDeleteMaterial(m.id)} className="text-red-400 p-2"><Icons.Trash className="w-5 h-5" /></button>
                    </div>
                ))}
              </div>

              <div className="pt-4 border-t border-slate-100 space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Neues Material hinzufügen</label>
                 <div className="flex gap-2">
                    <input type="text" value={newMaterialName} onChange={e => setNewMaterialName(e.target.value)} placeholder="Z.B. FROSTSCHUTZ..." className="flex-1 bg-slate-100 p-4 rounded-xl font-black uppercase text-sm outline-none focus:ring-2 focus:ring-amber-500" />
                    <button onClick={handleAddCustomMaterial} className="bg-amber-500 text-white p-4 rounded-xl shadow-lg active:scale-90 transition-transform"><Icons.Plus className="w-6 h-6" /></button>
                 </div>
              </div>

              <button onClick={() => setShowMaterialManager(false)} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase text-sm">Schliessen</button>
           </div>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/95 backdrop-blur-xl border-t border-slate-200 shadow-2xl grid grid-cols-4 px-2 safe-bottom z-[2500] shrink-0">
        <TabButton id="track" icon={Icons.MapPin} label="Karte" />
        <TabButton id="history" icon={Icons.History} label="Verlauf" />
        <TabButton id="stats" icon={Icons.Chart} label="Mengen" />
        <TabButton id="settings" icon={Icons.Settings} label="System" />
      </nav>
    </div>
  );
};

export default App;

