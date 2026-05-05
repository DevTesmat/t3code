export const SCROLL_TO_BOTTOM_VISIBILITY_THRESHOLD_PX = 8;

export function distanceFromScrollViewportBottom(scrollViewport: HTMLElement): number {
  return scrollViewport.scrollHeight - scrollViewport.clientHeight - scrollViewport.scrollTop;
}

export function isScrollViewportAtBottom(scrollViewport: HTMLElement): boolean {
  return (
    distanceFromScrollViewportBottom(scrollViewport) <= SCROLL_TO_BOTTOM_VISIBILITY_THRESHOLD_PX
  );
}
