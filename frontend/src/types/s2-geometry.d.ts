declare module 's2-geometry' {
  export interface LatLng { lat: number; lng: number }

  export class S2Cell {
    static FromHilbertQuadKey(key: string): S2Cell;
    static FromLatLng(latLng: LatLng, level: number): S2Cell;
    static FromFaceIJ(face: number, ij: [number, number], level: number): S2Cell;
    getLatLng(): LatLng;
    getCornerLatLngs(): LatLng[];
    getFaceAndQuads(): [number, number[]];
    toHilbertQuadkey(): string;
    getNeighbors(): S2Cell[];
  }

  export const S2: {
    L: { LatLng: (lat: number, lng: number, noWrap?: boolean) => LatLng };
    S2Cell: typeof S2Cell;
    latLngToKey: (lat: number, lng: number, level: number) => string;
    keyToId: (key: string) => string;
    idToKey: (id: string) => string;
    keyToLatLng: (key: string) => LatLng;
    idToLatLng: (id: string) => LatLng;
  };
}
