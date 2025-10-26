/**
 * 监听配置文件变化
 * @this {object} config 配置对象
 * @this {string} configFile 配置文件路径
 */
export function watcher(): Promise<void>;
/**
 * 创建配置文件
 * @param name 配置文件名
 * @param config 配置文件默认值
 * @param keep 保持不变的配置
 * @param opts 配置选项
 * @param opts.watch 是否监听配置文件变化
 * @param opts.replacer 配置文本替换函数
 * @returns 配置对象和配置保存函数
 */
export default function makeConfig<T = any>(name: string, config?: object, keep?: object, opts?: {
    watch: boolean;
    replacer: Function;
}): Promise<{
    /** 配置对象 */
    config: T;
    /** 保存配置 */
    configSave: () => Promise<void>;
}>;
