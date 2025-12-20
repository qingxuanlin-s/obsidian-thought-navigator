import { TFile, debounce, Notice } from "obsidian";
import ZKNavigationPlugin from "main";

/**
 * MOC 文件监听器
 * 负责监听 MOC 文件变化，使用内容哈希检测和防抖机制优化性能
 */
export class MOCFileMonitor {
    private plugin: ZKNavigationPlugin;
    
    // 内容哈希缓存：文件路径 -> {哈希值, 时间戳}
    private contentHashCache: Map<string, { hash: string; timestamp: number }> = new Map();
    
    // 防抖定时器：文件路径 -> 定时器
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    
    // 缓存大小限制
    private readonly MAX_CACHE_SIZE = 100;
    
    // 防抖延迟（毫秒）
    private readonly DEBOUNCE_DELAY = 500;

    constructor(plugin: ZKNavigationPlugin) {
        this.plugin = plugin;
    }

    /**
     * 初始化监听器，注册 Vault 事件
     */
    initialize(): void {
        console.log("MOC File Monitor: Initializing...");

        // 监听文件修改事件
        this.plugin.registerEvent(
            this.plugin.app.vault.on("modify", (file) => {
                if (file instanceof TFile && this.isMOCFile(file)) {
                    this.handleMOCFileChange(file);
                }
            })
        );

        // 监听文件重命名事件
        this.plugin.registerEvent(
            this.plugin.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile && this.isMOCFile(file)) {
                    // 清除旧路径的缓存
                    this.contentHashCache.delete(oldPath);
                    this.debounceTimers.delete(oldPath);
                    // 触发刷新
                    this.handleMOCFileChange(file);
                }
            })
        );

        // 监听文件删除事件
        this.plugin.registerEvent(
            this.plugin.app.vault.on("delete", (file) => {
                if (file instanceof TFile && this.isMOCFile(file)) {
                    // 清除缓存
                    this.contentHashCache.delete(file.path);
                    this.debounceTimers.delete(file.path);
                    // 触发刷新（通知视图该 MOC 已删除）
                    this.refreshViews(file);
                }
            })
        );

        console.log("MOC File Monitor: Initialized successfully");
    }

    /**
     * 检查文件是否是 MOC 文件
     */
    isMOCFile(file: TFile): boolean {
        const mocFolder = this.plugin.settings.mocFolderPath;
        if (!mocFolder) return false;
        
        // 检查文件是否在 MOC 文件夹中
        return file.path.startsWith(mocFolder + '/') || file.path.startsWith(mocFolder);
    }

    /**
     * 计算文件内容的哈希值（使用 FNV-1a 算法）
     * FNV-1a 是一个快速、简单的哈希算法，适合字符串哈希
     */
    private async calculateHash(content: string): Promise<string> {
        let hash = 2166136261; // FNV offset basis (32-bit)
        
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = Math.imul(hash, 16777619); // FNV prime
        }
        
        // 转换为 36 进制字符串（更短）
        return (hash >>> 0).toString(36);
    }

    /**
     * 检查文件内容是否发生变化
     */
    private async hasContentChanged(file: TFile): Promise<boolean> {
        try {
            // 读取文件内容
            const content = await this.plugin.app.vault.read(file);
            
            // 计算新哈希
            const newHash = await this.calculateHash(content);
            
            // 获取缓存的哈希
            const cached = this.contentHashCache.get(file.path);
            
            if (!cached) {
                // 首次检查，更新缓存
                this.updateCache(file.path, newHash);
                return true;
            }
            
            // 对比哈希值
            if (newHash !== cached.hash) {
                // 内容已变化，更新缓存
                this.updateCache(file.path, newHash);
                return true;
            }
            
            // 内容未变化
            return false;
        } catch (error) {
            console.error(`MOC Monitor: Failed to check content change for ${file.path}`, error);
            return false;
        }
    }

    /**
     * 更新哈希缓存（带 LRU 清理）
     */
    private updateCache(filePath: string, hash: string): void {
        // 如果缓存已满，删除最旧的条目
        if (this.contentHashCache.size >= this.MAX_CACHE_SIZE) {
            let oldestKey: string | null = null;
            let oldestTime = Infinity;
            
            for (const [key, value] of this.contentHashCache.entries()) {
                if (value.timestamp < oldestTime) {
                    oldestTime = value.timestamp;
                    oldestKey = key;
                }
            }
            
            if (oldestKey) {
                this.contentHashCache.delete(oldestKey);
            }
        }
        
        // 添加新缓存
        this.contentHashCache.set(filePath, {
            hash,
            timestamp: Date.now()
        });
    }

    /**
     * 处理 MOC 文件变化（带防抖）
     */
    private handleMOCFileChange(file: TFile): void {
        // 清除该文件的旧定时器
        const existingTimer = this.debounceTimers.get(file.path);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // 设置新的防抖定时器
        const timer = setTimeout(async () => {
            try {
                // 检查内容是否真的变化了
                const hasChanged = await this.hasContentChanged(file);
                
                if (hasChanged) {
                    console.log(`MOC Monitor: Content changed, refreshing views for ${file.path}`);
                    await this.refreshViews(file);
                } else {
                    console.log(`MOC Monitor: Content unchanged, skipping refresh for ${file.path}`);
                }
            } catch (error) {
                console.error(`MOC Monitor: Error handling file change for ${file.path}`, error);
            } finally {
                // 清除定时器引用
                this.debounceTimers.delete(file.path);
            }
        }, this.DEBOUNCE_DELAY);
        
        // 保存定时器引用
        this.debounceTimers.set(file.path, timer);
    }

    /**
     * 刷新相关视图
     */
    private async refreshViews(file: TFile): Promise<void> {
        try {
            // 触发自定义事件，通知视图更新
            this.plugin.app.workspace.trigger(
                "zk-navigation:moc-file-changed",
                file
            );
            
            console.log(`MOC Monitor: Triggered refresh event for ${file.path}`);
        } catch (error) {
            console.error(`MOC Monitor: Failed to refresh views for ${file.path}`, error);
            new Notice(`MOC 文件更新失败: ${error.message}`);
        }
    }

    /**
     * 清理资源
     */
    cleanup(): void {
        console.log("MOC File Monitor: Cleaning up...");
        
        // 清除所有防抖定时器
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        
        // 清除哈希缓存
        this.contentHashCache.clear();
        
        console.log("MOC File Monitor: Cleanup complete");
    }

    /**
     * 获取缓存统计信息（用于调试）
     */
    getCacheStats(): { size: number; maxSize: number; files: string[] } {
        return {
            size: this.contentHashCache.size,
            maxSize: this.MAX_CACHE_SIZE,
            files: Array.from(this.contentHashCache.keys())
        };
    }
}
