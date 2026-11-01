{{#if variables.role}}{{> manual doks=(doks_for_role (where_status doks "active") variables.role) vars=variables}}{{else}}{{> manual doks=(where_status doks "active") vars=variables}}{{/if}}
