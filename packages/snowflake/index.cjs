const {
	getEnv,
	EvidenceType,
	TypeFidelity,
	asyncIterableToBatchedAsyncGenerator,
	exhaustStream
} = require('@evidence-dev/db-commons');
const snowflake = require('snowflake-sdk');
const crypto = require('crypto');

const envMap = {
	authenticator: [
		{ key: 'EVIDENCE_SNOWFLAKE_AUTHENTICATOR', deprecated: false },
		{ key: 'SNOWFLAKE_AUTHENTICATOR', deprecated: false }
	],
	account: [
		{ key: 'EVIDENCE_SNOWFLAKE_ACCOUNT', deprecated: false },
		{ key: 'SNOWFLAKE_ACCOUNT', deprecated: false },
		{ key: 'ACCOUNT', deprecated: true },
		{ key: 'account', deprecated: true }
	],
	username: [
		{ key: 'EVIDENCE_SNOWFLAKE_USERNAME', deprecated: false },
		{ key: 'SNOWFLAKE_USERNAME', deprecated: false },
		{ key: 'USERNAME', deprecated: true },
		{ key: 'username', deprecated: true }
	],
	password: [
		{ key: 'EVIDENCE_SNOWFLAKE_PASSWORD', deprecated: false },
		{ key: 'SNOWFLAKE_PASSWORD', deprecated: false },
		{ key: 'PASSWORD', deprecated: true },
		{ key: 'password', deprecated: true }
	],
	database: [
		{ key: 'EVIDENCE_SNOWFLAKE_DATABASE', deprecated: false },
		{ key: 'SNOWFLAKE_DATABASE', deprecated: false },
		{ key: 'DATABASE', deprecated: true },
		{ key: 'database', deprecated: true }
	],
	warehouse: [
		{ key: 'EVIDENCE_SNOWFLAKE_WAREHOUSE', deprecated: false },
		{ key: 'SNOWFLAKE_WAREHOUSE', deprecated: false },
		{ key: 'WAREHOUSE', deprecated: true },
		{ key: 'warehouse', deprecated: true }
	],
	role: [
		{ key: 'EVIDENCE_SNOWFLAKE_ROLE', deprecated: false },
		{ key: 'SNOWFLAKE_ROLE', deprecated: false }
	],
	schema: [
		{ key: 'EVIDENCE_SNOWFLAKE_SCHEMA', deprecated: false },
		{ key: 'SNOWFLAKE_SCHEMA', deprecated: false }
	],
	privateKey: [
		{ key: 'EVIDENCE_SNOWFLAKE_PRIVATE_KEY', deprecated: false },
		{ key: 'SNOWFLAKE_PRIVATE_KEY', deprecated: false }
	],
	passphrase: [
		{ key: 'EVIDENCE_SNOWFLAKE_PASSPHRASE', deprecated: false },
		{ key: 'SNOWFLAKE_PASSPHRASE', deprecated: false }
	],
	okta_url: [
		{ key: 'EVIDENCE_SNOWFLAKE_OKTA_URL', deprecated: false },
		{ key: 'SNOWFLAKE_OKTA_URL', deprecated: false }
	]
};

/**
 *
 * @param {snowflake.Connection} connection
 * @param {string} queryString
 * @param {boolean} useAsync
 * @returns {Promise<{ rows: import("stream").Readable, columns: import('snowflake-sdk').Column[], totalRows: number }>}
 */
const execute = async (connection, queryString, useAsync = false) => {
	return new Promise((resolve, reject) => {
		function finishExecution() {
			connection.execute({
				sqlText: queryString,
				streamResult: true,
				complete: function (err, stmt) {
					if (err) {
						reject(err);
					} else {
						const columns = stmt
							.getColumns()
							.map((next) => ({ name: next.getName(), type: next.getType() }));
						resolve({ rows: stmt.streamRows(), columns, totalRows: stmt.getNumRows() });
					}
				}
			});
		}

		if (useAsync) {
			connection
				.connectAsync((err) => {
					if (err) {
						reject(err);
					}
				})
				.then(finishExecution);
		} else {
			connection.connect((err) => {
				if (err) {
					reject(err);
				}
			});
			finishExecution();
		}
	});
};

/**
 *
 * @param {string} dataBaseType
 * @param {undefined} defaultResultEvidenceType
 * @returns {EvidenceType | undefined}
 */
const nativeTypeToEvidenceType = function (dataBaseType, defaultResultEvidenceType = undefined) {
	if (dataBaseType) {
		let standardizedDBType = dataBaseType.toUpperCase();
		if (standardizedDBType.indexOf('(') >= 0) {
			//handles NUMBER(precision, scale) etc
			standardizedDBType = standardizedDBType.substring(0, standardizedDBType.indexOf('(')).trim();
		}
		switch (standardizedDBType) {
			case 'BOOLEAN':
				return EvidenceType.BOOLEAN;
			case 'INT':
			case 'INTEGER':
			case 'BIGINT':
			case 'SMALLINT':
			case 'NUMBER':
			case 'DECIMAL':
			case 'NUMERIC':
			case 'FLOAT':
			case 'FLOAT4':
			case 'FLOAT8':
			case 'DOUBLE':
			case 'DOUBLE PRECISION':
			case 'REAL':
			case 'FIXED':
				return EvidenceType.NUMBER;
			case 'VARCHAR':
			case 'CHAR':
			case 'CHARACTER':
			case 'STRING':
			case 'TEXT':
			case 'TIME':
				return EvidenceType.STRING;
			case 'TIMESTAMP':
			case 'TIMESTAMP_LTZ':
			case 'TIMESTAMP_NTZ':
			case 'TIMESTAMP_TZ':
			case 'DATE':
				return EvidenceType.DATE;
			case 'VARIANT':
			case 'ARRAY':
			case 'OBJECT':
				return defaultResultEvidenceType;
		}
	}
	return defaultResultEvidenceType;
};

/**
 *
 * @param {Awaited<ReturnType<typeof execute>>} results
 * @returns {import('@evidence-dev/db-commons').ColumnDefinition[] | undefined}
 */
const mapResultsToEvidenceColumnTypes = function (results) {
	return results.columns.map((field) => {
		/** @type {TypeFidelity} */
		let typeFidelity = TypeFidelity.PRECISE;
		let evidenceType = nativeTypeToEvidenceType(field.type);
		if (!evidenceType) {
			typeFidelity = TypeFidelity.INFERRED;
			evidenceType = EvidenceType.STRING;
		}
		return {
			name: field.name.toLowerCase(), // opening an issue for this -- not sure if we should just respect snowflake capitalizing all column names, or not. makes for unpleasant syntax elsewhere
			evidenceType: evidenceType,
			typeFidelity: typeFidelity
		};
	});
};

/**
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
const standardizeRow = (row) => {
	const lowerCasedRow = {};
	for (const [key, value] of Object.entries(row)) {
		lowerCasedRow[key.toLowerCase()] = value;
	}
	return lowerCasedRow;
};

/**
 * @param {Partial<SnowflakeOptions>} database
 * @returns {snowflake.ConnectionOptions}
 */
const getCredentials = (database = {}) => {
	const authenticator = database.authenticator ?? getEnv(envMap, 'authenticator') ?? 'snowflake';
	const account = database.account ?? getEnv(envMap, 'account');
	const username = database.username ?? getEnv(envMap, 'username');
	const default_database = database.database ?? getEnv(envMap, 'database');
	const warehouse = database.warehouse ?? getEnv(envMap, 'warehouse');
	const role = database.role ?? getEnv(envMap, 'role');
	const schema = database.schema ?? getEnv(envMap, 'schema');

	if (authenticator === 'snowflake_jwt') {
		const private_key = database.private_key ?? getEnv(envMap, 'privateKey');
		const passphrase = database.passphrase ?? getEnv(envMap, 'passphrase');

		const private_key_object = crypto.createPrivateKey({
			key: private_key,
			format: 'pem',
			passphrase
		});
		const decrypted_private_key = private_key_object.export({
			type: 'pkcs8',
			format: 'pem'
		});

		return {
			privateKey: decrypted_private_key,
			username,
			account,
			database: default_database,
			warehouse,
			role,
			schema,
			authenticator
		};
	} else if (authenticator === 'externalbrowser') {
		return {
			username,
			account,
			database: default_database,
			warehouse,
			role,
			schema,
			authenticator
		};
	} else if (authenticator === 'okta') {
		return {
			username,
			password: database.password ?? getEnv(envMap, 'password'),
			account,
			database: default_database,
			warehouse,
			role,
			schema,
			authenticator: database.okta_url ?? getEnv(envMap, 'okta_url')
		};
	} else {
		return {
			username,
			password: database.password ?? getEnv(envMap, 'password'),
			account,
			database: default_database,
			warehouse,
			schema,
			role
		};
	}
};

/** @type {import('@evidence-dev/db-commons').RunQuery<SnowflakeOptions>} */
const runQuery = async (queryString, database, batchSize = 100000) => {
	try {
		const credentials = getCredentials(database);

		const connection = snowflake.createConnection({ ...credentials, streamResult: true });

		const execution = await execute(
			connection,
			queryString,
			credentials.authenticator?.startsWith('https://') ||
				credentials.authenticator === 'externalbrowser'
		);

		const result = await asyncIterableToBatchedAsyncGenerator(execution.rows, batchSize, {
			standardizeRow
		});
		result.columnTypes = mapResultsToEvidenceColumnTypes(execution);
		result.expectedRowCount = execution.totalRows;

		return result;
	} catch (err) {
		if (err.message) {
			throw err.message.replace(/\n|\r/g, ' ');
		} else {
			throw err.replace(/\n|\r/g, ' ');
		}
	}
};

module.exports = runQuery;

/**
 * @typedef {Object} SnowflakeBaseOptions
 * @property {string} account
 * @property {string} username
 * @property {string} database
 * @property {string} warehouse
 * @property {string} role
 * @property {string} schema
 */

/**
 * @typedef {Object} SnowflakeJwtOptions
 * @property {'snowflake_jwt'} authenticator
 * @property {string} private_key
 * @property {string} passphrase
 */

/**
 * @typedef {Object} SnowflakeBrowserOptions
 * @property {'externalbrowser'} authenticator
 */

/**
 * @typedef {Object} SnowflakeOktaOptions
 * @property {'okta'} authenticator
 * @property {string} password
 * @property {string} okta_url
 */

/**
 * @typedef {SnowflakeBaseOptions & (SnowflakeJwtOptions | SnowflakeBrowserOptions | SnowflakeOktaOptions)} SnowflakeOptions
 */

/** @type {import('@evidence-dev/db-commons').GetRunner<SnowflakeOptions>} */
module.exports.getRunner = async (opts) => {
	return async (queryContent, queryPath, batchSize) => {
		// Filter out non-sql files
		if (!queryPath.endsWith('.sql')) return null;
		return runQuery(queryContent, opts, batchSize);
	};
};

module.exports.testConnection = async (opts) => {
	return await runQuery('SELECT 1;', opts)
		.then(exhaustStream)
		.then(() => true)
		.catch((e) => ({ reason: e.message ?? 'Invalid Credentials' }));
};

module.exports.options = {
	account: {
		title: 'Account',
		type: 'string',
		secret: false,
		required: true
	},
	username: {
		title: 'Username',
		type: 'string',
		secret: true,
		shown: true,
		required: true
	},
	database: {
		title: 'Database',
		type: 'string',
		secret: false,
		required: true
	},
	warehouse: {
		title: 'Warehouse',
		type: 'string',
		secret: false,
		required: true
	},
	role: {
		title: 'Role',
		type: 'string',
		secret: false,
		required: false
	},
	schema: {
		title: 'Schema',
		type: 'string',
		secret: false,
		required: false
	},
	authenticator: {
		title: 'Auth Method',
		type: 'select',
		secret: false,
		required: true,
		options: [
			{ label: 'Username/Password', value: 'userpass' },
			{ label: 'JWT', value: 'snowflake_jwt' },
			{ label: 'Browser', value: 'externalbrowser' },
			{ label: 'Okta', value: 'okta' }
		],
		nest: false,
		children: {
			userpass: {
				password: {
					title: 'Password',
					type: 'string',
					secret: true,
					required: true
				}
			},
			snowflake_jwt: {
				private_key: {
					title: 'Private Key',
					type: 'string',
					secret: true,
					required: true
				},
				passphrase: {
					title: 'Passphrase',
					type: 'string',
					secret: true,
					required: true
				}
			},
			okta: {
				password: {
					title: 'Password',
					type: 'string',
					secret: true,
					required: true
				},
				okta_url: {
					title: 'Okta URL',
					type: 'string',
					secret: true,
					required: true
				}
			}
		}
	}
};
