declare module "react" {
  export function useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[],
  ): T;
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useState<S>(
    initial: S | (() => S),
  ): [S, (next: S | ((previous: S) => S)) => void];
  export interface FormEvent<T = Element> {
    preventDefault(): void;
    currentTarget: T;
    target: EventTarget;
  }
}
