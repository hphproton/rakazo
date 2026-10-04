declare module "@novnc/novnc" {
  export interface RfbOptions {
    shared?: boolean;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
  }
}
