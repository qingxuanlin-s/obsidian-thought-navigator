/** 必须在 Cytoscape 初始化前注册：它的 wheel 监听运行在容器捕获阶段。 */
export function interceptPreviewWheel(container: HTMLElement): () => void {
	const onWheel = (event: WheelEvent) => {
		const target = event.target as HTMLElement | null;
		if (!target?.closest?.('.zk-embed-preview-card')) return;
		// 保留浏览器原生的滚动、横向滚动和滚动条操作；阻止画布先处理第一次滚轮。
		event.stopImmediatePropagation();
		if (event.ctrlKey) event.preventDefault();
	};
	container.addEventListener('wheel', onWheel, { capture: true, passive: false });
	return () => container.removeEventListener('wheel', onWheel, { capture: true });
}
