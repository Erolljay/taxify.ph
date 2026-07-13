```markdown
# taxify.ph Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `taxify.ph` JavaScript codebase. It covers file naming, import/export styles, commit message conventions, and testing patterns. By following these guidelines, contributors can maintain consistency and quality throughout the project.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.js`, `taxCalculator.js`

### Import Style
- Use **relative imports** for modules within the project.
  - Example:
    ```javascript
    import { calculateTax } from './taxCalculator';
    ```

### Export Style
- Use **named exports** for all exported functions, objects, or constants.
  - Example:
    ```javascript
    // taxCalculator.js
    export function calculateTax(amount) {
      // ...
    }
    ```

### Commit Messages
- Follow **conventional commit** style.
- Use the `feat` prefix for new features.
- Commit messages are descriptive, averaging around 93 characters.
  - Example:
    ```
    feat: add tax calculation for international transactions
    ```

## Workflows

### Feature Development
**Trigger:** When adding a new feature  
**Command:** `/feature-development`

1. Create a new branch for your feature.
2. Implement the feature using camelCase file naming and named exports.
3. Use relative imports for any internal modules.
4. Write or update tests in a corresponding `.test.js` file.
5. Commit your changes using the `feat` prefix and a descriptive message.
6. Open a pull request for review.

### Testing
**Trigger:** When verifying code changes  
**Command:** `/run-tests`

1. Identify or create `.test.js` files for the modules you modified.
2. Run the test suite using the project's test runner (framework is unknown; check project scripts).
3. Ensure all tests pass before merging or submitting your changes.

## Testing Patterns

- Test files are named with the pattern `*.test.js` and are located alongside or near the modules they test.
- The specific testing framework is not detected; check the project documentation or scripts for details.
- Example test file:
  ```javascript
  // taxCalculator.test.js
  import { calculateTax } from './taxCalculator';

  test('calculates tax for standard amount', () => {
    expect(calculateTax(100)).toBe(12);
  });
  ```

## Commands
| Command              | Purpose                                      |
|----------------------|----------------------------------------------|
| /feature-development | Step-by-step guide for adding new features   |
| /run-tests           | Instructions for running the test suite      |
```
