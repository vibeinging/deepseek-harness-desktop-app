// 迁移自 backend/core/utils/serialization.py

/**
 * 序列化管理模块
 *
 * 设计原则：
 * 1. 统一序列化逻辑 — 不再散落各处的 toDict() 调用
 * 2. 递归处理 — 自动处理嵌套对象
 * 3. 类型安全 — 只处理可序列化对象
 */

export class SerializationManager {
  /**
   * 将对象序列化为 JSON 兼容格式。
   *
   * 规则（优先级从高到低）：
   * 1. null / undefined → null
   * 2. 普通对象（非数组、非 Date、非 Map、非 Set）→ 递归序列化所有值
   * 3. Array → 递归序列化所有元素
   * 4. Set → 转为数组后递归序列化
   * 5. Map → 转为普通对象后递归序列化
   * 6. Date → ISO 字符串
   * 7. BigInt → Number（对应 Python Decimal → float）
   * 8. string / number / boolean → 原样返回
   * 9. 有 toDict() 方法的对象 → 调用后递归序列化
   * 10. 其他不可序列化类型 → 警告并返回 null
   *
   * @param {*} obj
   * @returns {*} JSON 兼容对象
   */
  static serialize(obj) {
    // 1. null / undefined
    if (obj === null || obj === undefined) return null;

    // 2. 普通对象（先判断，避免被 toDict 误拦截）
    if (
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      !(obj instanceof Date) &&
      !(obj instanceof Set) &&
      !(obj instanceof Map)
    ) {
      // 有 toDict 方法的业务对象（如 QueryGraph）
      if (typeof obj.toDict === 'function') {
        try {
          const dictResult = obj.toDict();
          return SerializationManager.serialize(dictResult);
        } catch (e) {
          console.warn(`调用 toDict() 失败: ${e?.message}，跳过该对象`);
          return null;
        }
      }

      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = SerializationManager.serialize(value);
      }
      return result;
    }

    // 3. Array
    if (Array.isArray(obj)) {
      return obj.map((item) => SerializationManager.serialize(item));
    }

    // 4. Set → 转数组
    if (obj instanceof Set) {
      return [...obj].map((item) => SerializationManager.serialize(item));
    }

    // 5. Map → 转普通对象
    if (obj instanceof Map) {
      const result = {};
      for (const [key, value] of obj.entries()) {
        result[key] = SerializationManager.serialize(value);
      }
      return result;
    }

    // 6. Date（含 Python datetime / date 对应）
    if (obj instanceof Date) {
      return obj.toISOString();
    }

    // 7. BigInt（对应 Python Decimal → float）
    if (typeof obj === 'bigint') {
      return Number(obj);
    }

    // 8. 基础类型
    if (
      typeof obj === 'string' ||
      typeof obj === 'number' ||
      typeof obj === 'boolean'
    ) {
      return obj;
    }

    // 10. 其他不可序列化类型
    console.warn(`不可序列化的对象类型: ${typeof obj}，跳过`);
    return null;
  }

  /**
   * 清理字典中的不可序列化对象（便捷方法）。
   *
   * @param {Object} data
   * @returns {Object}
   */
  static cleanForJson(data) {
    return SerializationManager.serialize(data);
  }
}

/**
 * 用于 JSON.stringify 的 replacer 函数。
 *
 * 使用示例：
 *   JSON.stringify(data, jsonReplacer)
 *
 * @param {string} _key
 * @param {*} value
 * @returns {*}
 */
export function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  // Buffer / Uint8Array → UTF-8 字符串
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (value && typeof value.toDict === 'function') {
    return value.toDict();
  }
  return value;
}
