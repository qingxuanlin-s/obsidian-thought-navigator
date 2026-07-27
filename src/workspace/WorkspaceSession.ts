import { OpenTarget } from "src/types/workspace";

export type WorkspaceSessionOrigin = 'graph' | 'workspace' | 'history' | 'restore' | 'external';

export interface WorkspaceSourceContext {
    target: OpenTarget;
    title?: string;
}

export interface WorkspaceSessionState {
    activeMocPath: string | null;
    selectedMocNodeId: string | null;
    selectedWorkspaceNodeId: string | null;
    selectedPlacementId: string | null;
    activeSpaceId: string | null;
    sourceWorkspaceTarget: WorkspaceSourceContext | null;
    origin: WorkspaceSessionOrigin;
    revision: number;
}

export type WorkspaceSessionSnapshot = Omit<WorkspaceSessionState, 'revision' | 'origin'>;

type SessionListener = (state: Readonly<WorkspaceSessionState>) => void;

const INITIAL_STATE: WorkspaceSessionState = {
    activeMocPath: null,
    selectedMocNodeId: null,
    selectedWorkspaceNodeId: null,
    selectedPlacementId: null,
    activeSpaceId: null,
    sourceWorkspaceTarget: null,
    origin: 'restore',
    revision: 0,
};

/**
 * 图谱与知识工作台共享的运行时上下文。
 * 不持久化业务数据，也不维护第二套历史；revision/origin 仅用于阻止双向联动回环。
 */
export class WorkspaceSession {
    private state: WorkspaceSessionState = { ...INITIAL_STATE };
    private listeners = new Set<SessionListener>();

    getState(): Readonly<WorkspaceSessionState> {
        return this.state;
    }

    snapshot(): WorkspaceSessionSnapshot {
        const { revision: _revision, origin: _origin, ...snapshot } = this.state;
        return {
            ...snapshot,
            sourceWorkspaceTarget: snapshot.sourceWorkspaceTarget
                ? { ...snapshot.sourceWorkspaceTarget, target: { ...snapshot.sourceWorkspaceTarget.target } }
                : null,
        };
    }

    subscribe(listener: SessionListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    update(patch: Partial<WorkspaceSessionSnapshot>, origin: WorkspaceSessionOrigin): Readonly<WorkspaceSessionState> {
        this.state = {
            ...this.state,
            ...patch,
            sourceWorkspaceTarget: patch.sourceWorkspaceTarget === undefined
                ? this.state.sourceWorkspaceTarget
                : patch.sourceWorkspaceTarget,
            origin,
            revision: this.state.revision + 1,
        };
        for (const listener of this.listeners) {
            try { listener(this.state); } catch (error) {
                console.error('[zk-navigation] WorkspaceSession listener error', error);
            }
        }
        return this.state;
    }

    selectGraphNode(mocPath: string | null, mocNodeId: string | null): Readonly<WorkspaceSessionState> {
        return this.update({
            activeMocPath: mocPath,
            selectedMocNodeId: mocNodeId,
        }, 'graph');
    }

    selectWorkspaceTarget(target: OpenTarget, title?: string): Readonly<WorkspaceSessionState> {
        const location = target.kind === 'home' ? {} : {
            selectedWorkspaceNodeId: target.id,
            selectedPlacementId: 'placementId' in target ? target.placementId ?? null : null,
            activeSpaceId: target.kind === 'space' ? target.id : ('spaceId' in target ? target.spaceId ?? null : null),
        };
        return this.update(location, 'workspace');
    }

    /** 仅在工作台显式打开图谱时创建一次可返回的来源。 */
    enterGraphFromWorkspace(target: OpenTarget, title?: string): Readonly<WorkspaceSessionState> {
        return this.update({ sourceWorkspaceTarget: { target: { ...target }, title } }, 'workspace');
    }

    clearWorkspaceSource(): Readonly<WorkspaceSessionState> {
        return this.update({ sourceWorkspaceTarget: null }, 'graph');
    }

    restore(snapshot: WorkspaceSessionSnapshot): Readonly<WorkspaceSessionState> {
        return this.update(snapshot, 'history');
    }

    clear(): void {
        this.state = { ...INITIAL_STATE, revision: this.state.revision + 1 };
        for (const listener of this.listeners) listener(this.state);
    }
}
