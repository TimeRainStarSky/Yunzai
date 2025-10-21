declare const _default: {
    config: Record<string, any>;
    watcher: Record<string, any>;
    /** 监听配置文件 */
    watch(file: string | string[], name: string, type?: string): void;
    /** 初始化配置 */
    initCfg(): void;
    /** 主人账号 */
    readonly masterQQ: (number | string)[];
    /** Bot账号:[主人帐号] */
    readonly master: Record<string, string[]>;
    /** 机器人账号 */
    readonly uin: string[];
    readonly qq: string[];
    /** package.json */
    readonly package: Record<string, any>;
    _package: Record<string, any>;
    /** 群配置 */
    getGroup(bot_id?: string, group_id?: string): Record<string, any>;
    /** other配置 */
    getOther(): Record<string, any>;
    /**
     * @param name 配置文件名称
     */
    getdefSet(name: string): Record<string, any>;
    /** 用户配置 */
    getConfig(name: string): Record<string, any>;
    getAllCfg(name: string): Record<string, any>;
    /**
     * 获取配置yaml
     * @param type 默认配置-default_config，用户配置-config
     * @param name 名称
     */
    getYaml(type: "default_config" | "config", name: string): Record<string, any>;
    change_bot(): Promise<void>;
};
export default _default;
