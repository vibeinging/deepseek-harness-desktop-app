# vexdb-lite SQLite 向量扩展 — 使用说明

给 SQLite 加**持久化向量检索**（HNSW 近似最近邻 + metadata 过滤）的扩展。
对标 sqlite-vec，但带图索引（ANN），大数据集快很多。版本 0.1.0。

---

## 1. 按平台取哪个文件

| 你的系统 | 用这个文件 | 说明 |
|---|---|---|
| **Windows** (x64) | `windows-x64/vexdb_lite.dll` | Win10 及以上，无需安装任何运行时 |
| **macOS** (Apple Silicon 或 Intel) | `macos/vexdb_lite.dylib` | universal，一个文件通吃 M 系列和 Intel 芯片 |

> Windows 的 `.dll` 是在 macOS 上交叉编译的（结构已验证，零外部依赖）。
> 首次使用建议先跑下面第 4 步的 `vexdb_version()` 确认能加载。

---

## 2. 前提条件

1. **宿主 SQLite ≥ 3.24**（用到 UPSERT、`sqlite3_vtab_nochange` 等）。
2. **必须启用扩展加载**。很多环境默认是**关**的，需要显式打开：
   - Python 的 `sqlite3`：默认禁用，要先 `conn.enable_load_extension(True)`。
   - sqlite3 命令行：默认允许 `.load`。
   - 其它语言的驱动：查各自的 “enable load extension / allow extension” 选项。

---

## 3. 加载扩展

加载时请**写完整文件名（带后缀）**，不要省略 `.dll` / `.dylib`——SQLite 自动补的后缀在 macOS 上是 `.so` 而不是 `.dylib`，省略会找不到文件。

**sqlite3 命令行：**
```sql
.load /path/to/vexdb_lite.dylib      -- macOS
.load C:/path/to/vexdb_lite.dll      -- Windows
```

**Python：**
```python
import sqlite3
conn = sqlite3.connect("my.db")
conn.enable_load_extension(True)          # 关键：默认是禁用的
conn.load_extension("/path/to/vexdb_lite.dylib")   # Windows 换成 .dll 路径
```

**Node.js（better-sqlite3）：**
```js
const db = require('better-sqlite3')('my.db');
db.loadExtension('/path/to/vexdb_lite.dylib');
```

---

## 4. 验证能加载

```sql
SELECT vexdb_version();
-- 返回类似：vexdb_lite sqlite extension <git短哈希> (2026-06-15 ...)
```
能返回版本字符串就说明加载成功。

---

## 5. 基本用法

### 建表（创建向量索引）

```sql
CREATE VIRTUAL TABLE items USING GRAPH_INDEX(
    embedding FLOAT[128],     -- 向量列，128 = 维度（必填、固定）
    category  TEXT,           -- 可选的 metadata 列（用于过滤）
    year      INTEGER,
    metric=l2,                -- 距离度量：l2 / cosine / ip（内积）
    m=16,                     -- HNSW 每节点邻居数（默认 16）
    ef_construction=64        -- 建图质量（默认 64，越大越准越慢）
);
```

### 插入向量

向量可以用 `vexdb_f32('[...]')` 把 JSON 数组转成 float32（推荐），或直接传 JSON 文本：
```sql
INSERT INTO items(rowid, embedding, category, year)
VALUES (1, vexdb_f32('[0.1, 0.2, ... ]'), 'news', 2026);
```

### 向量检索（KNN）

```sql
SELECT rowid, distance
FROM items
WHERE embedding MATCH vexdb_f32('[...]')   -- 查询向量
  AND k = 10                               -- 取最近 10 个
ORDER BY distance;                         -- 升序 = 最近优先
```
`distance` 三种度量统一“**越小越近**”（l2=欧氏距离、cosine=1−余弦相似度、ip=负内积）。

### 带过滤的检索（图内过滤，返回满足条件的真 top-k）

```sql
SELECT rowid, distance FROM items
WHERE embedding MATCH vexdb_f32('[...]')
  AND k = 10
  AND category = 'news'        -- 等值
  AND year >= 2025             -- 范围（> >= < <= 都支持）
ORDER BY distance;
```
拿到的是“满足条件的最近 10 个”，而不是“最近 10 个里恰好满足条件的几个”。

### 删除 / 更新

```sql
DELETE FROM items WHERE rowid = 1;
UPDATE items SET category = 'blog' WHERE rowid = 2;        -- 只改标签，不动向量（快）
UPDATE items SET embedding = vexdb_f32('[...]') WHERE rowid = 3;  -- 改向量
```

### 运行时调参（fts5 风格）

```sql
INSERT INTO items(items) VALUES ('ef_search=80');   -- 提高查询精度（默认 40，越大越准越慢）
INSERT INTO items(items) VALUES ('brute_force_threshold=64');
```

---

## 6. 参数速查

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `metric` | 建表 | l2 | `l2` / `cosine` / `ip` |
| `m` | 建表 | 16 | HNSW 邻居数，越大越准、内存越多 |
| `ef_construction` | 建表 | 64 | 建图扩展因子，越大质量越高、建得越慢 |
| `graph_memory_limit` | 建表 | 0(无限) | 字节；超过则用内存受限模式（大表省内存） |
| `ef_search` | 运行时 | 40 | 查询扩展因子，越大越准越慢 |

---

## 7. 距离函数（不建索引也能用）

```sql
SELECT vexdb_l2_distance('[1,2,3]', '[4,5,6]');
SELECT vexdb_cosine_distance(:a, :b);
SELECT vexdb_inner_product(:a, :b);            -- 内积（越大越相似）
SELECT vexdb_negative_inner_product(:a, :b);   -- 负内积（与 metric=ip 索引同向，越小越近）
SELECT vexdb_f32('[1,2,3]');                   -- JSON → float32 blob
SELECT vexdb_vector_to_json(:blob);            -- float32 blob → JSON
```

---

## 8. 注意事项

- **向量维度固定**：建表时 `FLOAT[N]` 的 N 定死，插入/查询的向量必须同维。
- **持久化**：索引随数据库文件保存，关库重开自动恢复，无需重建。索引数据放在
  几张隐藏的 shadow 表（`items_config` / `items_vectors` / `items_graph`）里，
  跟随宿主事务原子提交回滚——不要手动改这些表。
- **Windows .dll** 是交叉编译产物，建议拿到后先验证（第 4 步）再投入使用。
- 这是 **loadable 扩展**形态（运行时加载）。如果你要静态链接进 C/C++ 工程
  （移动端等），需要静态库 `.a` + 头文件，另外索取。

---

校验文件完整性：见同目录 `SHA256SUMS`。
