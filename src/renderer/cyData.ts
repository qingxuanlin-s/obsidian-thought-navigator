import type * as cytoscape from 'cytoscape';

/**
 * Cytoscape 元素 data 的类型化读取收口。
 *
 * Cytoscape 的 `.data(key)` 一律返回 `any`,直接使用会把 any 沿 return/参数
 * 一路扩散(no-unsafe-return / no-unsafe-argument 等)。所有读取都经过这里,
 * 把 any 在源头收窄成确定类型。
 */
type CyEle = cytoscape.NodeSingular | cytoscape.EdgeSingular;

/** 读取 data 为字符串;非字符串(含 undefined)返回空串。 */
export function dataStr(ele: CyEle, key: string): string {
    const v: unknown = ele.data(key);
    return typeof v === 'string' ? v : '';
}

/** 读取 data 为数字;非数字返回 undefined。 */
export function dataNum(ele: CyEle, key: string): number | undefined {
    const v: unknown = ele.data(key);
    return typeof v === 'number' ? v : undefined;
}

/** 读取 data 为布尔(按真值判定)。 */
export function dataBool(ele: CyEle, key: string): boolean {
    const v: unknown = ele.data(key);
    return Boolean(v);
}

/** 读取 data 并显式收窄到 T(调用方负责保证类型正确)。 */
export function dataAs<T>(ele: CyEle, key: string): T {
    return ele.data(key) as T;
}
