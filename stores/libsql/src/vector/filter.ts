import { BaseFilterTranslator } from '@mastra/core/vector/filter';
import type { VectorFilter, OperatorSupport, OperatorValueMap, VectorFieldValue } from '@mastra/core/vector/filter';

type LibSQLOperatorValueMap = Omit<
  OperatorValueMap,
  '$regex' | '$options' | '$in' | '$all' | '$nin' | '$eq' | '$ne'
> & {
  $size: number;
  $contains: VectorFieldValue | Record<string, unknown>;
  $all: VectorFieldValue;
  $in: VectorFieldValue;
  $nin: VectorFieldValue;
  $eq: VectorFieldValue;
  $ne: VectorFieldValue;
};
export type LibSQLVectorFilter = VectorFilter<keyof LibSQLOperatorValueMap, LibSQLOperatorValueMap>;

/**
 * Translates MongoDB-style filters to LibSQL compatible filters.
 *
 * Key differences from MongoDB:
 *
 * Logical Operators ($and, $or, $nor):
 * - Can be used at the top level or nested within fields
 * - Can take either a single condition or an array of conditions
 *
 */
export class LibSQLFilterTranslator extends BaseFilterTranslator<LibSQLVectorFilter> {
  protected override getSupportedOperators(): OperatorSupport {
    return {
      ...BaseFilterTranslator.DEFAULT_OPERATORS,
      regex: [],
      custom: ['$contains', '$size'],
    };
  }

  translate(filter?: LibSQLVectorFilter): LibSQLVectorFilter {
    if (this.isEmpty(filter)) {
      return filter;
    }
    this.validateFilter(filter);
    return this.translateNode(filter);
  }

  private translateNode(node: LibSQLVectorFilter, currentPath: string = ''): any {
    if (this.isRegex(node)) {
      throw new Error('Direct regex pattern format is not supported in LibSQL');
    }
    // Helper to wrap result with path if needed
    const withPath = (result: any) => (currentPath ? { [currentPath]: result } : result);

    // Handle primitives
    if (this.isPrimitive(node)) {
      return withPath({ $eq: this.normalizeComparisonValue(node) });
    }

    // Handle arrays
    if (Array.isArray(node)) {
      return withPath({ $in: this.normalizeArrayValues(node) });
    }

    // Handle regex
    // TODO: Look more into regex support for LibSQL
    // if (node instanceof RegExp) {
    //   return withPath(this.translateRegexPattern(node.source, node.flags));
    // }

    const entries = Object.entries(node as Record<string, any>);
    const result: Record<string, any> = {};

    // if ('$options' in node && !('$regex' in node)) {
    //   throw new Error('$options is not valid without $regex');
    // }

    // TODO: Look more into regex support for LibSQL
    // // Handle special regex object format
    // if ('$regex' in node) {
    //   const options = (node as any).$options || '';
    //   return withPath(this.translateRegexPattern(node.$regex, options));
    // }

    // Process remaining entries
    for (const [key, value] of entries) {
      // // Skip options as they're handled with $regex
      // if (key === '$options') continue;

      const newPath = currentPath ? `${currentPath}.${key}` : key;

      if (this.isLogicalOperator(key)) {
        result[key] = Array.isArray(value)
          ? value.map((filter: LibSQLVectorFilter) => this.translateNode(filter))
          : this.translateNode(value);
      } else if (this.isOperator(key)) {
        if (this.isArrayOperator(key) && !Array.isArray(value) && key !== '$elemMatch') {
          result[key] = [value];
        } else if (this.isBasicOperator(key) && Array.isArray(value)) {
          result[key] = JSON.stringify(value);
        } else {
          result[key] = value;
        }
      } else if (typeof value === 'object' && value !== null) {
        // Handle nested objects
        const hasOperators = Object.keys(value).some(k => this.isOperator(k));
        if (hasOperators) {
          result[newPath] = this.translateNode(value);
        } else {
          Object.assign(result, this.translateNode(value, newPath));
        }
      } else {
        result[newPath] = this.translateNode(value);
      }
    }

    return result;
  }

  // TODO: Look more into regex support for LibSQL
  // private translateRegexPattern(pattern: string, options: string = ''): any {
  //   if (!options) return { $regex: pattern };

  //   const flags = options
  //     .split('')
  //     .filter(f => 'imsux'.includes(f))
  //     .join('');

  //   return {
  //     $regex: pattern,
  //     $options: flags,
  //   };
  // }
}
