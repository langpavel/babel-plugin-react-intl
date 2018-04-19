/*
 * Copyright 2015, Yahoo Inc.
 * Pavel Lang (@langpavel) 2018
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 * 
 * @flow
 */

import * as p from 'path';
import { writeFileSync } from 'fs';
import { sync as mkdirpSync } from 'mkdirp';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = ['FormattedMessage', 'FormattedHTMLMessage'];

const FUNCTION_NAMES = ['defineMessages'];

const EXTRACTED = Symbol('ReactIntlExtracted');
const MESSAGES = Symbol('ReactIntlMessages');
const ERR_PRELUDE = '[babel-plugin-react-intl] ';

/*::
export type BabelPluginReactIntlConfig = {|
    moduleSourceName?: string,
    extractSourceLocation: boolean,
    enforceDescriptions: boolean,
    messageProps?: string[],
    extraProps?: string[],
    removeProps?: string[] | boolean,
    messagesDir?: string,
|}
*/

const defaultOptions = {
  // name of import or require module which sense this plugin
  moduleSourceName: 'react-intl',
  // if true, this module will capture exact source location of every definition
  extractSourceLocation: false,
  // require 'description' property in original source
  enforceDescriptions: false,
  // names of properties which must be ICU compliant
  messageProps: ['defaultMessage'],
  // names of other properties which will be extracted
  extraProps: [],
  // names of properties which will be removed from output
  // should contain all messageProps in production build
  removeProps: ['description'],
  // directory, where extracted messages can be written.
  messagesDir: undefined,
};

const configMap = new WeakMap();
const getConfig = (opts /*: BabelPluginReactIntlConfig */ = defaultOptions) => {
  const cached = configMap.get(opts);
  if (cached) return cached;

  const allowedKeys = Object.keys(defaultOptions);
  const allowedKeySet = new Set(allowedKeys);

  const optKeys = Object.keys(opts);
  if (optKeys.some(key => !allowedKeySet.has(key))) {
    const unexpected = optKeys.filter(key => !allowedKeySet.has(key));
    throw new Error(
      `${ERR_PRELUDE}Unexpected '${unexpected.join("', '")}'\n` +
        `Allowed keys for 'babel-plugin-react-intl' are '${allowedKeys.join(
          "', '"
        )}'`
    );
  }

  const moduleSourceName =
    opts.moduleSourceName || defaultOptions.moduleSourceName;
  const extractSourceLocation =
    opts.extractSourceLocation || defaultOptions.extractSourceLocation;
  const enforceDescriptions =
    opts.enforceDescriptions || defaultOptions.enforceDescriptions;
  const messagePropsArray /*: string[] */ =
    opts.messageProps || defaultOptions.messageProps || [];
  const extraPropsArray /*: string[] */ =
    opts.extraProps || defaultOptions.extraProps || [];
  let removePropsArray /*: string[] */;
  if (typeof opts.removeProps === 'undefined') {
    // $FlowFixMe
    removePropsArray = defaultOptions.removeProps;
  } else if (opts.removeProps === true) {
    // everything except `id`
    removePropsArray = [
      'description',
      ...messagePropsArray,
      ...extraPropsArray,
    ];
  } else if (opts.removeProps === false) {
    removePropsArray = [];
  } else if (Array.isArray(opts.removeProps)) {
    removePropsArray = opts.removeProps;
  } else {
    throw new Error(
      `${ERR_PRELUDE}'removeProps' must be true, false of array of string`
    );
  }

  const config = {
    moduleSourceName,
    extractSourceLocation,
    enforceDescriptions,
    messageProps: new Set(messagePropsArray),
    descriptorProps: new Set([
      'id',
      'description',
      ...messagePropsArray,
      ...extraPropsArray,
    ]),
    // $FlowFixMe
    removeProps: new Set(removePropsArray),
  };

  configMap.set(opts, config);
  return config;
};

// $FlowFixMe
export default function({ types: t }) {
  const evaluatePath = path => {
    const evaluated = path.evaluate();
    if (evaluated.confident) {
      return evaluated.value;
    }

    throw path.buildCodeFrameError(
      `${ERR_PRELUDE}Messages must be statically evaluate-able for extraction.`
    );
  };

  const getMessageDescriptorKey = path => {
    if (path.isIdentifier() || path.isJSXIdentifier()) {
      return path.node.name;
    }

    return evaluatePath(path);
  };

  const getMessageDescriptorValue = path => {
    if (path.isJSXExpressionContainer()) {
      path = path.get('expression');
    }

    // Always trim the Message Descriptor values.
    const descriptorValue = evaluatePath(path);

    if (typeof descriptorValue === 'string') {
      return descriptorValue.trim();
    }

    return descriptorValue;
  };

  const getICUMessageValue = (messagePath, { isJSXSource = false } = {}) => {
    const message = getMessageDescriptorValue(messagePath);

    try {
      return printICUMessage(message);
    } catch (parseError) {
      if (
        isJSXSource &&
        messagePath.isLiteral() &&
        message.indexOf('\\\\') >= 0
      ) {
        throw messagePath.buildCodeFrameError(
          `${ERR_PRELUDE}Message failed to parse. ` +
            'It looks like `\\`s were used for escaping, ' +
            "this won't work with JSX string literals. " +
            'Wrap with `{}`. ' +
            'See: http://facebook.github.io/react/docs/jsx-gotchas.html'
        );
      }

      throw messagePath.buildCodeFrameError(
        `${ERR_PRELUDE}Message failed to parse. ` +
          'See: http://formatjs.io/guides/message-syntax/' +
          `\n${parseError}`
      );
    }
  };

  const createMessageDescriptor = (cfg, propPaths) => {
    return propPaths.reduce((hash, [keyPath, valuePath]) => {
      const key = getMessageDescriptorKey(keyPath);

      if (cfg.descriptorProps.has(key)) {
        hash[key] = valuePath;
      }

      return hash;
    }, Object.create(null));
  };

  const evaluateMessageDescriptor = (
    cfg,
    { ...descriptor },
    { isJSXSource = false } = {}
  ) => {
    Object.keys(descriptor).forEach(key => {
      const valuePath = descriptor[key];

      if (cfg.messageProps.has(key)) {
        descriptor[key] = getICUMessageValue(valuePath, { isJSXSource });
      } else {
        descriptor[key] = getMessageDescriptorValue(valuePath);
      }
    });

    return descriptor;
  };

  const storeMessage = (msg, path, state) => {
    const { file, opts } = state;

    if (!msg.id) {
      throw path.buildCodeFrameError(
        `${ERR_PRELUDE}Message Descriptors require an 'id'.`
      );
    }

    const messages = file.get(MESSAGES);
    if (messages.has(msg.id)) {
      const existing = messages.get(msg.id);

      const newKeys = Object.keys(msg);
      newKeys.forEach(key => {
        if (existing[key] && msg[key] && existing[key] !== msg[key]) {
          throw path.buildCodeFrameError(
            `${ERR_PRELUDE}Duplicate message id: "${msg.id}", ` +
              'but the `description` and/or `default` and/or `defaultMessage` are different.'
          );
        }
        // fill up missing
        existing[key] = msg[key];
      });
    }

    if (opts.enforceDescriptions) {
      if (
        !msg.description ||
        (typeof msg.description === 'object' &&
          Object.keys(msg.description).length < 1)
      ) {
        throw path.buildCodeFrameError(
          `${ERR_PRELUDE}Message must have a 'description'.`
        );
      }
    }

    let loc;
    if (opts.extractSourceLocation) {
      loc = {
        file: p.relative(process.cwd(), file.opts.filename),
        ...path.node.loc,
      };
    }

    messages.set(msg.id, { ...msg, ...loc });
  };

  const referencesImport = (path, mod, importedNames) => {
    if (!(path.isIdentifier() || path.isJSXIdentifier())) {
      return false;
    }

    return importedNames.some(name => path.referencesImport(mod, name));
  };

  const tagAsExtracted = path => {
    path.node[EXTRACTED] = true;
  };

  const wasExtracted = path => {
    return !!path.node[EXTRACTED];
  };

  return {
    // $FlowFixMe
    pre(file) {
      if (!file.has(MESSAGES)) {
        file.set(MESSAGES, new Map());
      }
    },

    // $FlowFixMe
    post(file) {
      const { opts } = this;
      const { filename } = file.opts;

      const basename = p.basename(filename, p.extname(filename));
      const messages = file.get(MESSAGES);
      const descriptors = [...messages.values()];
      file.metadata['react-intl'] = { messages: descriptors };

      if (opts.messagesDir && descriptors.length > 0) {
        // Make sure the relative path is "absolute" before
        // joining it with the `messagesDir`.
        const relativePath = p.join(p.sep, p.relative(process.cwd(), filename));

        const messagesFilename = p.join(
          opts.messagesDir,
          p.dirname(relativePath),
          basename + '.json'
        );

        const messagesFile = JSON.stringify(descriptors, null, 2);

        mkdirpSync(p.dirname(messagesFilename));
        writeFileSync(messagesFilename, messagesFile);
      }
    },

    visitor: {
      // $FlowFixMe
      JSXOpeningElement(path, state) {
        if (wasExtracted(path)) {
          return;
        }

        const { file, opts } = state;
        const cfg = getConfig(opts);

        const name = path.get('name');

        if (name.referencesImport(cfg.moduleSourceName, 'FormattedPlural')) {
          file.log.warn(
            `${ERR_PRELUDE}Line ${path.node.loc.start.line}: ` +
              'Default messages are not extracted from ' +
              '<FormattedPlural>, use <FormattedMessage> instead.'
          );

          return;
        }

        if (referencesImport(name, cfg.moduleSourceName, COMPONENT_NAMES)) {
          const attributes = path
            .get('attributes')
            .filter(attr => attr.isJSXAttribute());

          let descriptor = createMessageDescriptor(
            cfg,
            attributes.map(attr => [attr.get('name'), attr.get('value')])
          );

          // In order for a default message to be extracted when
          // declaring a JSX element, it must be done with standard
          // `key=value` attributes. But it's completely valid to
          // write `<FormattedMessage {...descriptor} />` or
          // `<FormattedMessage id={dynamicId} />`, because it will be
          // skipped here and extracted elsewhere. The descriptor will
          // be extracted only if a some prop is in MESSAGE_PROPS.
          if (Object.keys(descriptor).some(key => cfg.messageProps.has(key))) {
            // Evaluate the Message Descriptor values in a JSX
            // context, then store it.
            descriptor = evaluateMessageDescriptor(cfg, descriptor, {
              isJSXSource: true,
            });

            storeMessage(descriptor, path, state);

            // Remove description since it's not used at runtime.
            attributes.forEach(attr => {
              const keyPath = attr.get('name');
              const key = getMessageDescriptorKey(keyPath);
              if (cfg.removeProps && cfg.removeProps.has(key)) {
                attr.remove();
              }
            });

            // Tag the AST node so we don't try to extract it twice.
            tagAsExtracted(path);
          }
        }
      },

      // $FlowFixMe
      CallExpression(path, state) {
        const { opts } = state;
        const callee = path.get('callee');
        const cfg = getConfig(opts);

        const assertObjectExpression = node => {
          if (!(node && node.isObjectExpression())) {
            throw path.buildCodeFrameError(
              `${ERR_PRELUDE}\`${callee.node.name}()\` must be ` +
                'called with an object expression with values ' +
                'that are React Intl Message Descriptors, also ' +
                'defined as object expressions.'
            );
          }
        };

        const processMessageObject = messageObj => {
          assertObjectExpression(messageObj);

          if (wasExtracted(messageObj)) return;

          const properties = messageObj.get('properties');

          let descriptor = createMessageDescriptor(
            cfg,
            properties.map(prop => [prop.get('key'), prop.get('value')])
          );

          // Evaluate the Message Descriptor values, then store it.
          descriptor = evaluateMessageDescriptor(cfg, descriptor);
          storeMessage(descriptor, messageObj, state);

          // Tag the AST node so we don't try to extract it twice.
          tagAsExtracted(messageObj);

          if (!cfg.removeProps) return;

          const replacementObject = [
            t.objectProperty(
              t.stringLiteral('id'),
              t.stringLiteral(descriptor.id)
            ),
          ];

          const keys = Object.keys(descriptor);
          keys.forEach(key => {
            if (cfg.removeProps.has(key)) return;
            replacementObject.push(
              t.objectProperty(
                t.stringLiteral(key),
                t.stringLiteral(descriptor[key])
              )
            );
          });

          messageObj.replaceWith(t.objectExpression(replacementObject));
        };

        if (referencesImport(callee, cfg.moduleSourceName, FUNCTION_NAMES)) {
          const messagesObj = path.get('arguments')[0];

          assertObjectExpression(messagesObj);

          messagesObj
            .get('properties')
            .map(prop => prop.get('value'))
            .forEach(processMessageObject);
        }
      },
    },
  };
}
