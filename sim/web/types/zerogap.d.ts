// PLACEHOLDER - will be generated from the API spec (docs/API.md source).
// Declares zerogap's system modules for editor completions.
declare module "zg:ui" {
  export class Widget {
    set(props: object): this;
    on(event: string, handler: (ev: any) => void): this;
    focus(): void;
    delete(): void;
  }
  export class Container extends Widget { constructor(parent?: Widget | object, props?: object); }
  export class Label extends Widget { constructor(parent?: Widget | object, props?: { text?: string; font?: number; color?: string }); text: string; }
  export class Button extends Widget { constructor(parent?: Widget | object, props?: { text?: string; onClick?: (ev: any) => void }); text: string; }
  export const screen: Container;
  export const width: number;
  export const height: number;
}
declare module "zg:sys" {
  export const app: { id: string; name: string; version: string };
  export function log(...args: any[]): void;
  export function exit(): void;
}
