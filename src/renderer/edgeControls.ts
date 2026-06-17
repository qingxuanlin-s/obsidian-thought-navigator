import * as cytoscape from 'cytoscape';
import { Notice } from 'obsidian';
import type { GraphData } from './types';
import { OverlayScheduler } from './overlayScheduler';

type GroupInfo = { id: string; label: string; nodeIds: string[] };

export interface EdgeControlsDeps {
	getCy(): cytoscape.Core | null;
	getContainer(): HTMLElement | null;
	getCurrentData(): GraphData | null;
	overlayScheduler: OverlayScheduler;
	showGroupActionDialog(
		existingGroups: GroupInfo[],
		callback: (action: 'new' | 'add', groupId?: string) => void
	): void;
	showGroupNameDialog(callback: (name: string | null) => void, defaultValue?: string): void;
}

export class EdgeControls {
	private isEdgeSelected = false;
	private edgeControlSelectHandler: ((evt: any) => void) | null = null;
	private edgeControlUnselectHandler: (() => void) | null = null;
	private edgeControlRemoveHandler: (() => void) | null = null;
	private edgeEndpointSelectHandler: ((evt: any) => void) | null = null;
	private edgeEndpointUnselectHandler: (() => void) | null = null;
	private edgeEndpointRemoveHandler: (() => void) | null = null;
	private edgeControlPointUpdaters: Set<() => void> = new Set();
	private edgeEndpointUpdaters: Set<() => void> = new Set();
	// 连线手柄(hover 小蓝点)的统一定位 updater。单独持有引用以便重复调用 addConnectionHandles
	// 时先注销旧的,避免在不经过 cleanupScheduler 的增量路径上累积。
	private connectionPositionUpdater: (() => void) | null = null;

	constructor(private deps: EdgeControlsDeps) {}

	cleanupBindings(): void {
		const cy = this.deps.getCy();
		if (!cy) return;
		if (this.edgeControlSelectHandler) {
			cy.off('select', 'edge', this.edgeControlSelectHandler);
			this.edgeControlSelectHandler = null;
		}
		if (this.edgeControlUnselectHandler) {
			cy.off('unselect', 'edge', this.edgeControlUnselectHandler);
			this.edgeControlUnselectHandler = null;
		}
		if (this.edgeControlRemoveHandler) {
			cy.off('remove', 'edge', this.edgeControlRemoveHandler);
			this.edgeControlRemoveHandler = null;
		}
		if (this.edgeEndpointSelectHandler) {
			cy.off('select', 'edge', this.edgeEndpointSelectHandler);
			this.edgeEndpointSelectHandler = null;
		}
		if (this.edgeEndpointUnselectHandler) {
			cy.off('unselect', 'edge', this.edgeEndpointUnselectHandler);
			this.edgeEndpointUnselectHandler = null;
		}
		if (this.edgeEndpointRemoveHandler) {
			cy.off('remove', 'edge', this.edgeEndpointRemoveHandler);
			this.edgeEndpointRemoveHandler = null;
		}
		cy.nodes().forEach((node: any) => {
			const listeners = node.scratch('_zkConnectionHandleListeners');
			if (!listeners) return;
			if (listeners.mouseover) node.off('mouseover', listeners.mouseover);
			if (listeners.mouseout) node.off('mouseout', listeners.mouseout);
			node.removeScratch('_zkConnectionHandleListeners');
		});
		this.clearTransientUpdaters();
		this.isEdgeSelected = false;
	}

	clearTransientUpdaters(): void {
		this.edgeControlPointUpdaters.forEach(fn => {
			this.deps.overlayScheduler.updaters.delete(fn);
			this.deps.overlayScheduler.immediateUpdaters.delete(fn);
		});
		this.edgeControlPointUpdaters.clear();
		this.edgeEndpointUpdaters.forEach(fn => {
			this.deps.overlayScheduler.updaters.delete(fn);
		});
		this.edgeEndpointUpdaters.clear();
		if (this.connectionPositionUpdater) {
			this.deps.overlayScheduler.updaters.delete(this.connectionPositionUpdater);
			this.deps.overlayScheduler.immediateUpdaters.delete(this.connectionPositionUpdater);
			this.connectionPositionUpdater = null;
		}
	}

	addConnectionHandles(): void {
		const cy = this.deps.getCy();
		const container = this.deps.getContainer();
		if (!cy || !container) return;

		// 自幂等:移除上一次注册的统一定位 updater,避免在增量路径(不走 cleanupScheduler)上累积。
		if (this.connectionPositionUpdater) {
			this.deps.overlayScheduler.updaters.delete(this.connectionPositionUpdater);
			this.deps.overlayScheduler.immediateUpdaters.delete(this.connectionPositionUpdater);
			this.connectionPositionUpdater = null;
		}

		const oldHandleContainer = container.querySelector('.zk-connection-handles');
		if (oldHandleContainer) oldHandleContainer.remove();

		const handleContainer = document.createElement('div');
		handleContainer.className = 'zk-connection-handles';
		handleContainer.setCssStyles({
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			pointerEvents: 'none',
			zIndex: '3',
		});
		container.appendChild(handleContainer);

		const handleUpdaters: Array<() => void> = [];

		cy.nodes('[!isPlaceholder]').forEach((node: any) => {
			// 自幂等:解绑该节点上一次的 hover 监听(独立调用时无 cleanupBindings 兜底),避免重复绑定。
			const oldListeners = node.scratch('_zkConnectionHandleListeners');
			if (oldListeners) {
				if (oldListeners.mouseover) node.off('mouseover', oldListeners.mouseover);
				if (oldListeners.mouseout) node.off('mouseout', oldListeners.mouseout);
			}
			const handle = document.createElement('div');
			handle.className = 'zk-connection-handle';
			const baseHandleSize = 36;
			handle.setCssStyles({
				position: 'absolute',
				width: `${baseHandleSize}px`,
				height: `${baseHandleSize}px`,
				background: 'radial-gradient(circle at 50% 34%, #7aa6e6 0%, #5b8fd9 60%, #4a7bc4 100%)',
				border: '1.5px solid rgba(255, 255, 255, 0.55)',
				borderRadius: '50%',
				cursor: 'crosshair',
				pointerEvents: 'auto',
				transform: 'translate(-50%, -50%)',
				boxShadow: '0 0 10px rgba(91, 143, 217, 0.55), 0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.35)',
				opacity: '0',
				transition: 'opacity 0.2s',
			});
			handle.setCssStyles({ display: 'none' });
			handleContainer.appendChild(handle);

			const nodeId = node.id();
			let handleImageCardCache: HTMLElement | null = null;
			let handleEmbedCardCache: HTMLElement | null = null;
			let handleLastZoom = -1;
			const updateHandlePosition = () => {
				const currentCy = this.deps.getCy();
				const currentContainer = this.deps.getContainer();
				if (!currentCy || !currentContainer) return;
				if (handle.style.opacity === '0') {
					handle.setCssStyles({ display: 'none' });
					return;
				}

				const isHidden =
					node.removed() ||
					node.hasClass('zk-collapsed-hidden') ||
					node.style('display') === 'none' ||
					!node.visible();
				if (isHidden) {
					handle.setCssStyles({ display: 'none' });
					return;
				}

				const zoom = currentCy.zoom();
				const curIsImageNode = node.data('isImageNode');
				const curIsEmbedNode = node.data('isEmbed');

				let x: number, y: number;
				if (curIsImageNode) {
					const rp = node.renderedPosition();
					if (!Number.isFinite(rp?.x) || !Number.isFinite(rp?.y)) {
						handle.setCssStyles({ display: 'none' });
						return;
					}
					if (!handleImageCardCache) handleImageCardCache = currentContainer.querySelector(`.zk-image-preview-card[data-node-id="${nodeId}"]`) as HTMLElement ?? null;
					if (handleImageCardCache && handleImageCardCache.dataset.renderedWidth) {
						const cardW = parseFloat(handleImageCardCache.dataset.renderedWidth);
						x = rp.x + cardW / 2;
						y = rp.y;
					} else {
						x = rp.x; y = rp.y;
					}
				} else if (curIsEmbedNode) {
					const boundingBox = node.renderedBoundingBox();
					if (!Number.isFinite(boundingBox?.x1) || !Number.isFinite(boundingBox?.x2) || !Number.isFinite(boundingBox?.y1) || !Number.isFinite(boundingBox?.y2)) {
						handle.setCssStyles({ display: 'none' });
						return;
					}
					if (!handleEmbedCardCache) handleEmbedCardCache = currentContainer.querySelector(`.zk-embed-preview-card[data-node-id="${nodeId}"]`) as HTMLElement ?? null;
					if (handleEmbedCardCache) {
						const cardW = handleEmbedCardCache.offsetWidth;
						x = boundingBox.x1 + cardW;
					} else {
						x = boundingBox.x2;
					}
					y = (boundingBox.y1 + boundingBox.y2) / 2;
				} else {
					const boundingBox = node.renderedBoundingBox();
					if (!Number.isFinite(boundingBox?.x2) || !Number.isFinite(boundingBox?.y1) || !Number.isFinite(boundingBox?.y2)) {
						handle.setCssStyles({ display: 'none' });
						return;
					}
					x = boundingBox.x2;
					y = (boundingBox.y1 + boundingBox.y2) / 2;
				}

				if (!Number.isFinite(x) || !Number.isFinite(y)) {
					handle.setCssStyles({ display: 'none' });
					return;
				}

				handle.setCssStyles({
					display: 'block',
					transform: `translate(${x}px, ${y}px) translate(-50%, -50%)`,
				});
				if (zoom !== handleLastZoom) {
					handleLastZoom = zoom;
					handle.setCssStyles({
						width: `${baseHandleSize * zoom}px`,
						height: `${baseHandleSize * zoom}px`,
						borderWidth: `${2 * zoom}px`,
					});
				}
			};

			handleUpdaters.push(updateHandlePosition);
			updateHandlePosition();

			handle.dataset.imageNodeId = nodeId;
			handle.dataset.embedNodeId = nodeId;

			// 小蓝点左半边压在节点右边缘上(x = x2,translate(-50%))。鼠标从节点内向右移到小蓝点时,
			// 指针落到 handle(pointer-events:auto,z-index 高于画布)上 → cytoscape 立刻对节点派发
			// mouseout。若此时立即 display:none,小蓝点会在「节点→小蓝点」的交接处消失,且因元素已隐藏,
			// handle 自身的 mouseenter 永远不会触发。故改为「延迟隐藏 + handle.mouseenter 取消隐藏」:
			// node.mouseout 仅预约隐藏(此刻 handle 仍可见可命中),指针真正落到 handle 上时 mouseenter
			// 取消预约,从而桥接交接间隙。从节点外接近时同理无副作用。
			let hideTimer: number | null = null;
			const cancelHide = () => {
				if (hideTimer !== null) {
					clearTimeout(hideTimer);
					hideTimer = null;
				}
			};
			const showHandle = () => {
				if (this.isEdgeSelected) return;
				cancelHide();
				handle.setCssStyles({ opacity: '1' });
				updateHandlePosition();
			};
			const scheduleHide = () => {
				cancelHide();
				hideTimer = window.setTimeout(() => {
					hideTimer = null;
					handle.setCssStyles({
						opacity: '0',
						display: 'none',
					});
				}, 80);
			};

			const handleMouseOver = showHandle;
			const handleMouseOut = scheduleHide;
			node.on('mouseover', handleMouseOver);
			node.on('mouseout', handleMouseOut);
			node.scratch('_zkConnectionHandleListeners', {
				mouseover: handleMouseOver,
				mouseout: handleMouseOut
			});

			handle.addEventListener('mouseenter', showHandle);
			handle.addEventListener('mouseleave', (e: MouseEvent) => {
				const currentContainer = this.deps.getContainer();
				const imageCard = currentContainer?.querySelector(`.zk-image-preview-card[data-node-id="${nodeId}"]`);
				if (imageCard && (e.relatedTarget === imageCard || imageCard.contains(e.relatedTarget as Node))) return;
				const embedCard = currentContainer?.querySelector(`.zk-embed-preview-card[data-node-id="${nodeId}"]`);
				if (embedCard && (e.relatedTarget === embedCard || embedCard.contains(e.relatedTarget as Node))) return;
				scheduleHide();
			});

			this.bindConnectionDrag(handle, node);
		});

		const connectionPositionUpdater = () => handleUpdaters.forEach(updater => updater());
		this.connectionPositionUpdater = connectionPositionUpdater;
		this.deps.overlayScheduler.updaters.add(connectionPositionUpdater);
		this.deps.overlayScheduler.immediateUpdaters.add(connectionPositionUpdater);
	}

	addEdgeControlPoints(): void {
		const cy = this.deps.getCy();
		const container = this.deps.getContainer();
		if (!cy || !container) return;

		const oldControlPointContainer = container.querySelector('.zk-edge-control-points');
		if (oldControlPointContainer) oldControlPointContainer.remove();

		const controlPointContainer = document.createElement('div');
		controlPointContainer.className = 'zk-edge-control-points';
		controlPointContainer.setCssStyles({
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			pointerEvents: 'none',
			zIndex: '2',
		});
		container.appendChild(controlPointContainer);

		this.edgeControlSelectHandler = (evt: any) => {
			const edge = evt.target;
			this.isEdgeSelected = true;
			this.deps.getContainer()?.querySelectorAll('.zk-connection-handle').forEach((h: Element) => {
				(h as HTMLElement).setCssStyles({
					opacity: '0',
					pointerEvents: 'none',
				});
			});
			this.showEdgeControlPoint(edge, controlPointContainer);
		};
		cy.on('select', 'edge', this.edgeControlSelectHandler);

		this.edgeControlUnselectHandler = () => {
			this.isEdgeSelected = false;
			this.deps.getContainer()?.querySelectorAll('.zk-connection-handle').forEach((h: Element) => {
				(h as HTMLElement).setCssStyles({ pointerEvents: 'auto' });
			});
			this.hideEdgeControlPoints(controlPointContainer);
		};
		cy.on('unselect', 'edge', this.edgeControlUnselectHandler);

		this.edgeControlRemoveHandler = () => {
			this.isEdgeSelected = false;
			this.deps.getContainer()?.querySelectorAll('.zk-connection-handle').forEach((h: Element) => {
				(h as HTMLElement).setCssStyles({ pointerEvents: 'auto' });
			});
			this.hideEdgeControlPoints(controlPointContainer);
		};
		cy.on('remove', 'edge', this.edgeControlRemoveHandler);
	}

	addEdgeEndpointHandles(): void {
		const cy = this.deps.getCy();
		const container = this.deps.getContainer();
		if (!cy || !container) return;

		const oldContainer = container.querySelector('.zk-edge-endpoint-handles');
		if (oldContainer) oldContainer.remove();

		const handleContainer = document.createElement('div');
		handleContainer.className = 'zk-edge-endpoint-handles';
		handleContainer.setCssStyles({
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			pointerEvents: 'none',
			zIndex: '2',
		});
		container.appendChild(handleContainer);

		this.edgeEndpointSelectHandler = (evt: any) => {
			const edge = evt.target;
			this.showEdgeEndpointHandles(edge, handleContainer);
		};
		cy.on('select', 'edge', this.edgeEndpointSelectHandler);

		this.edgeEndpointUnselectHandler = () => {
			this.hideEdgeEndpointHandles(handleContainer);
		};
		cy.on('unselect', 'edge', this.edgeEndpointUnselectHandler);

		this.edgeEndpointRemoveHandler = () => {
			this.hideEdgeEndpointHandles(handleContainer);
		};
		cy.on('remove', 'edge', this.edgeEndpointRemoveHandler);
	}

	createGroupFromNodes(nodes: any[]): void {
		if (nodes.length === 0) return;

		const validNodes = nodes.filter(node => {
			const data = node.data();
			return !data.isPlaceholder && !data.isGroup && data.originalNode;
		});
		if (validNodes.length === 0) return;

		const nodeIds = validNodes.map(node => node.data('originalNode').ID);
		const existingGroups = this.findGroupsContainingNodes(nodeIds);
		const container = this.deps.getContainer();

		if (existingGroups.length > 0) {
			this.deps.showGroupActionDialog(existingGroups, (action, targetGroupId) => {
				if (action === 'new') {
					this.deps.showGroupNameDialog((groupLabel) => {
						if (!groupLabel) return;
						const groupId = `group_${Date.now()}`;
						container?.dispatchEvent(new CustomEvent('group-create', {
							detail: { groupId, groupLabel, nodeIds }
						}));
					});
				} else if (action === 'add' && targetGroupId) {
					container?.dispatchEvent(new CustomEvent('group-add-nodes', {
						detail: { groupId: targetGroupId, nodeIds }
					}));
				}
			});
			return;
		}

		this.deps.showGroupNameDialog((groupLabel) => {
			if (!groupLabel) return;
			const groupId = `group_${Date.now()}`;
			container?.dispatchEvent(new CustomEvent('group-create', {
				detail: { groupId, groupLabel, nodeIds }
			}));
		});
	}

	private bindConnectionDrag(handle: HTMLElement, sourceNode: any): void {
		if (!this.deps.getCy() || !this.deps.getContainer()) return;

		let isDragging = false;
		let dragLine: SVGLineElement | null = null;
		let svgOverlay: SVGSVGElement | null = null;
		const detachDocListeners = () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
		};

		handle.addEventListener('mousedown', (e: MouseEvent) => {
			const container = this.deps.getContainer();
			if (!container) return;
			e.preventDefault();
			e.stopPropagation();

			isDragging = true;
			handle.setCssStyles({ opacity: '1' });
			svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svgOverlay.setCssStyles({
				position: 'absolute',
				top: '0',
				left: '0',
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				zIndex: '2',
			});
			container.appendChild(svgOverlay);

			dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			dragLine.setAttribute('stroke', '#10b981');
			dragLine.setAttribute('stroke-width', '2');
			dragLine.setAttribute('stroke-dasharray', '5,5');
			dragLine.setAttribute('opacity', '0.8');
			svgOverlay.appendChild(dragLine);

			const sourcePos = sourceNode.renderedPosition();
			dragLine.setAttribute('x1', sourcePos.x.toString());
			dragLine.setAttribute('y1', sourcePos.y.toString());
			dragLine.setAttribute('x2', sourcePos.x.toString());
			dragLine.setAttribute('y2', sourcePos.y.toString());

			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
		});

		let dragMoveRafId: number | null = null;
		const handleMouseMove = (e: MouseEvent) => {
			const cy = this.deps.getCy();
			const container = this.deps.getContainer();
			if (!isDragging || !dragLine || !cy || !container) return;

			const containerRect = container.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;
			const sourcePos = sourceNode.renderedPosition();
			dragLine.setAttribute('x1', sourcePos.x.toString());
			dragLine.setAttribute('y1', sourcePos.y.toString());
			dragLine.setAttribute('x2', mouseX.toString());
			dragLine.setAttribute('y2', mouseY.toString());

			if (dragMoveRafId !== null) return;
			dragMoveRafId = requestAnimationFrame(() => {
				dragMoveRafId = null;
				const currentCy = this.deps.getCy();
				if (!isDragging || !dragLine || !currentCy) return;

				const targetNode = this.getNodeAtPosition({ x: mouseX, y: mouseY });
				if (targetNode && targetNode !== sourceNode) {
					dragLine.setAttribute('stroke', '#10b981');
					dragLine.setAttribute('stroke-width', '3');
					dragLine.setAttribute('opacity', '1');
					targetNode.addClass('connection-target-hover');
				} else {
					dragLine.setAttribute('stroke', '#10b981');
					dragLine.setAttribute('stroke-width', '2');
					dragLine.setAttribute('opacity', '0.8');
					currentCy.nodes('.connection-target-hover').removeClass('connection-target-hover');
				}
			});
		};

		const handleMouseUp = async (e: MouseEvent) => {
			detachDocListeners();
			const cy = this.deps.getCy();
			const container = this.deps.getContainer();
			if (!isDragging || !cy || !container) return;

			isDragging = false;
			const containerRect = container.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;
			const targetNode = this.getNodeAtPosition({ x: mouseX, y: mouseY });

			if (svgOverlay) {
				svgOverlay.remove();
				svgOverlay = null;
			}
			dragLine = null;
			cy.nodes('.connection-target-hover').removeClass('connection-target-hover');

			const sourceData = sourceNode.data();
			const sourceOriginalNode = sourceData.originalNode;
			const sourceId = sourceData.originalNodeId || sourceData.id;

			if (targetNode && targetNode !== sourceNode) {
				const targetData = targetNode.data();
				const targetOriginalNode = targetData.originalNode;
				const targetId = targetData.originalNodeId || targetData.id;
				container.dispatchEvent(new CustomEvent('create-arrow-relation', {
					detail: {
						sourceId,
						targetId,
						sourceIsGroup: !!sourceData.isGroup,
						targetIsGroup: !!targetData.isGroup,
						sourceNode: sourceOriginalNode,
						targetNode: targetOriginalNode
					}
				}));
				return;
			}

			if (!sourceOriginalNode) return;
			const modelPos = cy.pan();
			const zoom = cy.zoom();
			const graphX = (mouseX - modelPos.x) / zoom;
			const graphY = (mouseY - modelPos.y) / zoom;
			container.dispatchEvent(new CustomEvent('create-child-node', {
				detail: {
					parentNode: sourceOriginalNode,
					position: { x: graphX, y: graphY }
				}
			}));
		};
	}

	private getNodeAtPosition(pos: { x: number; y: number }): any {
		const cy = this.deps.getCy();
		if (!cy) return null;

		const normalNodes = cy.nodes('[!isGroup][!isPlaceholder]');
		for (let i = 0; i < normalNodes.length; i++) {
			const node = normalNodes[i];
			const bb = node.renderedBoundingBox();
			if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
				return node;
			}
		}

		const groupNodes = cy.nodes('[?isGroup]');
		for (let i = 0; i < groupNodes.length; i++) {
			const node = groupNodes[i];
			const bb = node.renderedBoundingBox();
			if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
				return node;
			}
		}

		return null;
	}

	private showEdgeControlPoint(edge: any, container: HTMLElement): void {
		const cy = this.deps.getCy();
		const graphContainer = this.deps.getContainer();
		if (!cy || !graphContainer) return;

		this.hideEdgeControlPoints(container);
		const data = edge.data();
		const sourceNode = cy.$id(data.source);
		const targetNode = cy.$id(data.target);
		if (!sourceNode.length || !targetNode.length) return;

		const distance = data.controlPointDistance !== undefined ? data.controlPointDistance : 0;
		const weight = data.controlPointWeight !== undefined ? data.controlPointWeight : 0.5;
		const controlPoint = document.createElement('div');
		controlPoint.className = 'zk-edge-control-point';
		controlPoint.setCssStyles({
			position: 'absolute',
			width: '14px',
			height: '14px',
			backgroundColor: 'rgba(148, 163, 184, 0.95)',
			border: '2px solid rgba(255, 255, 255, 0.95)',
			borderRadius: '50%',
			cursor: 'grab',
			pointerEvents: 'auto',
			transform: 'translate(-50%, -50%)',
			boxShadow: '0 2px 6px rgba(0, 0, 0, 0.35)',
			zIndex: '1000',
		});
		container.appendChild(controlPoint);

		const updateControlPointPosition = () => {
			if (!this.deps.getCy() || !edge.inside()) {
				controlPoint.setCssStyles({ display: 'none' });
				return;
			}
			let mid: { x: number; y: number } | null = null;
			try {
				mid = edge.renderedMidpoint();
			} catch { /* edge may have been removed */ }

			if (mid && isFinite(mid.x) && isFinite(mid.y)) {
				controlPoint.setCssStyles({
					display: 'block',
					transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`,
				});
			} else {
				controlPoint.setCssStyles({ display: 'none' });
			}
		};

		updateControlPointPosition();
		this.deps.overlayScheduler.updaters.add(updateControlPointPosition);
		this.deps.overlayScheduler.immediateUpdaters.add(updateControlPointPosition);
		this.edgeControlPointUpdaters.add(updateControlPointPosition);

		let isDragging = false;
		let dragStartDistance = distance;
		let dragStartProjection = 0;
		const CURVATURE_DRAG_SENSITIVITY = 1.5;
		const detachDocListeners = () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
		};

		controlPoint.addEventListener('mousedown', (e: MouseEvent) => {
			const currentContainer = this.deps.getContainer();
			if (!currentContainer) return;
			e.preventDefault();
			e.stopPropagation();
			const sourcePos = sourceNode.renderedPosition();
			const targetPos = targetNode.renderedPosition();
			const containerRect = currentContainer.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;
			const currentWeight = edge.data('controlPointWeight') !== undefined ? edge.data('controlPointWeight') : 0.5;
			const midX = sourcePos.x + (targetPos.x - sourcePos.x) * currentWeight;
			const midY = sourcePos.y + (targetPos.y - sourcePos.y) * currentWeight;
			const dx = targetPos.x - sourcePos.x;
			const dy = targetPos.y - sourcePos.y;
			const len = Math.sqrt(dx * dx + dy * dy) || 1;
			const perpX = -dy / len;
			const perpY = dx / len;

			isDragging = true;
			dragStartDistance = edge.data('controlPointDistance') !== undefined ? edge.data('controlPointDistance') : distance;
			dragStartProjection = (mouseX - midX) * perpX + (mouseY - midY) * perpY;
			controlPoint.setCssStyles({ cursor: 'grabbing' });
			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
		});

		const handleMouseMove = (e: MouseEvent) => {
			const currentContainer = this.deps.getContainer();
			if (!isDragging || !this.deps.getCy() || !currentContainer) return;
			const sourcePos = sourceNode.renderedPosition();
			const targetPos = targetNode.renderedPosition();
			const containerRect = currentContainer.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;
			const currentWeight = edge.data('controlPointWeight') !== undefined ? edge.data('controlPointWeight') : 0.5;
			const midX = sourcePos.x + (targetPos.x - sourcePos.x) * currentWeight;
			const midY = sourcePos.y + (targetPos.y - sourcePos.y) * currentWeight;
			const dx = targetPos.x - sourcePos.x;
			const dy = targetPos.y - sourcePos.y;
			const len = Math.sqrt(dx * dx + dy * dy);
			const perpX = -dy / len;
			const perpY = dx / len;
			const toMouseX = mouseX - midX;
			const toMouseY = mouseY - midY;
			const projectedDistance = toMouseX * perpX + toMouseY * perpY;
			const newDistance = dragStartDistance + (projectedDistance - dragStartProjection) * CURVATURE_DRAG_SENSITIVITY;

			edge.data('controlPointDistance', newDistance);
			edge.data('controlPointWeight', currentWeight);
			updateControlPointPosition();
			currentContainer.dispatchEvent(new CustomEvent('edge-curvature-changed', {
				detail: {
					edgeId: `${data.originalSource}-${data.originalTarget}`,
					source: data.originalSource || data.source,
					target: data.originalTarget || data.target,
					distance: newDistance,
					weight: currentWeight
				}
			}));
		};

		const handleMouseUp = () => {
			detachDocListeners();
			if (isDragging) {
				isDragging = false;
				controlPoint.setCssStyles({ cursor: 'grab' });
			}
		};

		const observer = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.removedNodes.forEach((node) => {
					if (node === controlPoint) {
						detachDocListeners();
						observer.disconnect();
					}
				});
			});
		});
		observer.observe(container, { childList: true });
	}

	private hideEdgeControlPoints(container: HTMLElement): void {
		this.edgeControlPointUpdaters.forEach(fn => {
			this.deps.overlayScheduler.updaters.delete(fn);
			this.deps.overlayScheduler.immediateUpdaters.delete(fn);
		});
		this.edgeControlPointUpdaters.clear();
		container.querySelectorAll('.zk-edge-control-point').forEach(cp => cp.remove());
	}

	private showEdgeEndpointHandles(edge: any, container: HTMLElement): void {
		const cy = this.deps.getCy();
		if (!cy) return;
		this.hideEdgeEndpointHandles(container);

		const data = edge.data();
		const sourceNode = cy.$id(data.source);
		const targetNode = cy.$id(data.target);
		if (!sourceNode.length || !targetNode.length) return;

		const originalTargetNode = targetNode.data().originalNode;
		const canModifyTarget = originalTargetNode && originalTargetNode.nodeSons === 1;
		const sourceHandle = this.createEndpointHandle('source', sourceNode, edge, container);
		let targetHandle: HTMLElement | null = null;
		if (canModifyTarget) {
			targetHandle = this.createEndpointHandle('target', targetNode, edge, container);
		}

		const endpointUpdater = () => {
			this.updateEndpointHandlePosition(sourceHandle, edge, 'source');
			if (targetHandle) this.updateEndpointHandlePosition(targetHandle, edge, 'target');
		};
		this.deps.overlayScheduler.updaters.add(endpointUpdater);
		this.edgeEndpointUpdaters.add(endpointUpdater);
		endpointUpdater();
		requestAnimationFrame(() => {
			requestAnimationFrame(endpointUpdater);
		});
	}

	private createEndpointHandle(type: 'source' | 'target', node: any, edge: any, container: HTMLElement): HTMLElement {
		const handle = document.createElement('div');
		handle.className = `zk-edge-endpoint-handle zk-edge-endpoint-${type}`;
		handle.setCssStyles({ display: 'none' });
		container.appendChild(handle);
		this.bindEndpointHandleDrag(handle, type, node, edge, container);
		return handle;
	}

	private updateEndpointHandlePosition(handle: HTMLElement, edge: any, type: 'source' | 'target'): void {
		if (!this.deps.getCy() || !edge.inside()) {
			handle.setCssStyles({ display: 'none' });
			return;
		}

		let endpoint: { x: number; y: number } | null = null;
		try {
			endpoint = type === 'source'
				? edge.renderedSourceEndpoint()
				: edge.renderedTargetEndpoint();
		} catch { /* edge may have been removed */ }

		if (endpoint && isFinite(endpoint.x) && isFinite(endpoint.y)) {
			handle.setCssStyles({
				display: 'block',
				transform: `translate(${endpoint.x}px, ${endpoint.y}px) translate(-50%, -50%)`,
			});
		} else {
			handle.setCssStyles({ display: 'none' });
		}
	}

	private hideEdgeEndpointHandles(container: HTMLElement): void {
		this.edgeEndpointUpdaters.forEach(fn => {
			this.deps.overlayScheduler.updaters.delete(fn);
		});
		this.edgeEndpointUpdaters.clear();
		container.querySelectorAll('.zk-edge-endpoint-handle').forEach(h => h.remove());
	}

	private bindEndpointHandleDrag(
		handle: HTMLElement,
		type: 'source' | 'target',
		sourceOrTargetNode: any,
		edge: any,
		container: HTMLElement
	): void {
		if (!this.deps.getCy() || !this.deps.getContainer()) return;

		let isDragging = false;
		let dragLine: SVGLineElement | null = null;
		let svgOverlay: SVGSVGElement | null = null;
		const detachDocListeners = () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
		};

		handle.addEventListener('mousedown', (e: MouseEvent) => {
			const graphContainer = this.deps.getContainer();
			const cy = this.deps.getCy();
			if (!graphContainer || !cy) return;
			e.preventDefault();
			e.stopPropagation();

			isDragging = true;
			handle.setCssStyles({ cursor: 'grabbing' });
			svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svgOverlay.setCssStyles({
				position: 'absolute',
				top: '0',
				left: '0',
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				zIndex: '2',
			});
			graphContainer.appendChild(svgOverlay);

			dragLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			dragLine.setAttribute('stroke', 'var(--interactive-accent, #3b82f6)');
			dragLine.setAttribute('stroke-width', '2');
			dragLine.setAttribute('stroke-dasharray', '6,4');
			svgOverlay.appendChild(dragLine);

			const edgeData = edge.data();
			const startPos = type === 'source'
				? cy.$id(edgeData.target).renderedPosition()
				: cy.$id(edgeData.source).renderedPosition();
			dragLine.setAttribute('x1', startPos.x.toString());
			dragLine.setAttribute('y1', startPos.y.toString());
			dragLine.setAttribute('x2', startPos.x.toString());
			dragLine.setAttribute('y2', startPos.y.toString());
			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
		});

		let endpointMoveRafId: number | null = null;
		const handleMouseMove = (e: MouseEvent) => {
			const cy = this.deps.getCy();
			const graphContainer = this.deps.getContainer();
			if (!isDragging || !dragLine || !cy || !graphContainer) return;

			const containerRect = graphContainer.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;
			const edgeData = edge.data();
			const startPos = type === 'source'
				? cy.$id(edgeData.target).renderedPosition()
				: cy.$id(edgeData.source).renderedPosition();
			dragLine.setAttribute('x1', startPos.x.toString());
			dragLine.setAttribute('y1', startPos.y.toString());
			dragLine.setAttribute('x2', mouseX.toString());
			dragLine.setAttribute('y2', mouseY.toString());

			if (endpointMoveRafId !== null) return;
			endpointMoveRafId = requestAnimationFrame(() => {
				endpointMoveRafId = null;
				const currentCy = this.deps.getCy();
				if (!isDragging || !dragLine || !currentCy) return;
				const targetNode = this.getNodeAtPosition({ x: mouseX, y: mouseY });
				if (targetNode && targetNode !== sourceOrTargetNode) {
					dragLine!.setAttribute('stroke', '#10b981');
					targetNode.addClass('connection-target-hover');
				} else {
					dragLine!.setAttribute('stroke', 'var(--interactive-accent, #3b82f6)');
					currentCy.nodes('.connection-target-hover').removeClass('connection-target-hover');
				}
			});
		};

		const handleMouseUp = async (e: MouseEvent) => {
			detachDocListeners();
			const cy = this.deps.getCy();
			const graphContainer = this.deps.getContainer();
			if (!isDragging || !cy || !graphContainer) return;

			isDragging = false;
			const containerRect = graphContainer.getBoundingClientRect();
			const mouseX = e.clientX - containerRect.left;
			const mouseY = e.clientY - containerRect.top;
			const newTargetNode = this.getNodeAtPosition({ x: mouseX, y: mouseY });

			if (svgOverlay) {
				svgOverlay.remove();
				svgOverlay = null;
			}
			dragLine = null;
			cy.nodes('.connection-target-hover').removeClass('connection-target-hover');
			handle.setCssStyles({ cursor: 'grab' });

			if (!newTargetNode || newTargetNode === sourceOrTargetNode) return;
			const edgeData = edge.data();
			if (type === 'source') {
				graphContainer.dispatchEvent(new CustomEvent('edge-source-changed', {
					detail: {
						edgeId: edgeData.id,
						edgeType: edgeData.type,
						oldSource: edgeData.originalSource || edgeData.source,
						newSource: newTargetNode.data().originalNode.IDStr,
						target: edgeData.originalTarget || edgeData.target,
						label: edgeData.label
					}
				}));
				return;
			}

			const newTargetData = newTargetNode.data();
			const newTargetNodeSons = newTargetData.originalNode.nodeSons;
			if (newTargetNodeSons > 1) {
				new Notice('无法连接到有子节点的节点');
				return;
			}
			const originalTargetNode = cy.$id(edgeData.target);
			const oldTargetID = originalTargetNode.data().originalNode.IDStr;
			const newTargetID = newTargetData.originalNode.IDStr;
			graphContainer.dispatchEvent(new CustomEvent('edge-target-changed', {
				detail: {
					edgeId: edgeData.id,
					edgeType: edgeData.type,
					source: edgeData.originalSource || edgeData.source,
					oldTarget: oldTargetID,
					newTarget: newTargetID,
					label: edgeData.label
				}
			}));
		};

		const observer = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.removedNodes.forEach((node) => {
					if (node === handle) {
						detachDocListeners();
						observer.disconnect();
					}
				});
			});
		});
		observer.observe(container, { childList: true });
	}

	private findGroupsContainingNodes(nodeIds: string[]): GroupInfo[] {
		const groups = this.deps.getCurrentData()?.metadata?.groups || [];
		const result: GroupInfo[] = [];
		for (const group of groups) {
			if (nodeIds.some(id => group.nodeIds.includes(id))) {
				result.push(group);
			}
		}
		return result;
	}
}
