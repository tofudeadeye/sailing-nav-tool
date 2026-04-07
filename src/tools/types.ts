import type { ChartData } from '../chartGen.ts';


export type ToolName =
  | 'pencil'
  | 'dividers'
  | 'parallel-rules'
  | 'plotter'
  | 'compass'
  | 'std'
  | null;

export type LineType = 'Course Line' | 'Bearing Line' | 'Position Line' | 'DR Track';

export interface DrawnLine {
  svgX1: number; svgY1: number;
  svgX2: number; svgY2: number;
  type: LineType;
  selected: boolean;
}

export interface DividersState {
  svgHingeX: number; svgHingeY: number;
  svgTip1X: number;  svgTip1Y: number;
  svgTip2X: number;  svgTip2Y: number;
  dragging: 'hinge' | 'tip1' | 'tip2' | 'rotate' | null;
  dragStartAngle: number;  // screen angle of pointer at rotate drag start (radians)
  rotatePivotSVGX: number; // SVG coords of the fixed pivot point during rotation
  rotatePivotSVGY: number;
}

export interface ParallelRulesState {
  rule1: { svgX: number; svgY: number };
  rule2: { svgX: number; svgY: number };
  angleDeg: number;
  svgW: number;
  svgH: number;
  dragging: 'rule1' | 'rule2' | null;
  pivot:    'rule1' | 'rule2' | null;
  dragStartSX: number; dragStartSY: number;
  dragStartX:  number; dragStartY:  number;
  onBearingUpdate: ((bearing: number, variation: number) => void) | null;
}

export interface PlotterState {
  svgX: number; svgY: number;
  angleDeg: number;
  roseAngleDeg: number;
  dragging: 'move' | 'rotate' | 'rose' | null;
  dragStartSX: number; dragStartSY: number;
  dragStartX:  number; dragStartY:  number;
  dragStartRoseAngle: number;
}

export interface STDResult {
  speed: number;
  timeMin: number;
  distNM: number;
}

export interface ToolState {
  activeTool: ToolName;
  lines: DrawnLine[];
  dividers: DividersState | null;
  parallelRules: ParallelRulesState | null;
  plotter: PlotterState | null;
  accumulatedDist: number;
  chartData: ChartData | null;
  vessel: { lat: number; lon: number } | null;
  stdResult: STDResult | null;
  eraseMode: boolean;
}

export interface WorkbookCallbacks {
  setBearing:  ((bearing: number, variation: number) => void) | null;
  setDistance: ((nm: number) => void) | null;
  setAccDist:  ((nm: number) => void) | null;
  setCourse:   ((bearing: number, variation: number) => void) | null;
  setETA:      ((eta: string) => void) | null;
  setDRPos:    ((lat: number, lon: number) => void) | null;
}

export interface BearingResult {
  trueBear: number;
  magBearing: number;
  error: number;
  landmark: { name: string; lat: number; lon: number };
}

export const state: ToolState = {
  activeTool: null,
  lines: [],
  dividers: null,
  parallelRules: null,
  plotter: null,
  accumulatedDist: 0,
  chartData: null,
  vessel: null,
  stdResult: null,
  eraseMode: false,
};

export const wb: WorkbookCallbacks = {
  setBearing: null, setDistance: null, setAccDist: null,
  setCourse: null, setETA: null, setDRPos: null,
};
