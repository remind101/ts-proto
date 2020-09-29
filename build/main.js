"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.visit = exports.generateFile = exports.LongOption = void 0;
const ts_poet_1 = require("ts-poet");
const pbjs_1 = require("../build/pbjs");
const types_1 = require("./types");
const sequency_1 = require("sequency");
const sourceInfo_1 = require("./sourceInfo");
const utils_1 = require("./utils");
var FieldDescriptorProto = pbjs_1.google.protobuf.FieldDescriptorProto;
var FileDescriptorProto = pbjs_1.google.protobuf.FileDescriptorProto;
const dataloader = ts_poet_1.TypeNames.anyType('DataLoader*dataloader');
var LongOption;
(function (LongOption) {
    LongOption["NUMBER"] = "number";
    LongOption["LONG"] = "long";
    LongOption["STRING"] = "string";
})(LongOption = exports.LongOption || (exports.LongOption = {}));
function generateFile(typeMap, fileDesc, parameter) {
    const options = utils_1.optionsFromParameter(parameter);
    // Google's protofiles are organized like Java, where package == the folder the file
    // is in, and file == a specific service within the package. I.e. you can have multiple
    // company/foo.proto and company/bar.proto files, where package would be 'company'.
    //
    // We'll match that stucture by setting up the module path as:
    //
    // company/foo.proto --> company/foo.ts
    // company/bar.proto --> company/bar.ts
    //
    // We'll also assume that the fileDesc.name is already the `company/foo.proto` path, with
    // the package already implicitly in it, so we won't re-append/strip/etc. it out/back in.
    const moduleName = fileDesc.name.replace('.proto', '.ts');
    let file = ts_poet_1.FileSpec.create(moduleName);
    const sourceInfo = sourceInfo_1.default.fromDescriptor(fileDesc);
    // Syntax, unlike most fields, is not repeated and thus does not use an index
    const headerComment = sourceInfo.lookup(sourceInfo_1.Fields.file.syntax, undefined);
    utils_1.maybeAddComment(headerComment, text => (file = file.addComment(text)));
    // first make all the type declarations
    visit(fileDesc, sourceInfo, (fullName, message, sInfo) => {
        file = file.addInterface(generateInterfaceDeclaration(typeMap, fullName, message, sInfo, options));
    }, options, (fullName, enumDesc, sInfo) => {
        file = file.addCode(generateEnum(options, fullName, enumDesc, sInfo));
    });
    if (options.outputEncodeMethods || options.outputJsonMethods) {
        // then add the encoder/decoder/base instance
        visit(fileDesc, sourceInfo, (fullName, message) => {
            file = file.addProperty(generateBaseInstance(fullName, message, options));
            let staticMethods = ts_poet_1.CodeBlock.empty()
                .add('export const %L = ', fullName)
                .beginHash();
            staticMethods = !options.outputEncodeMethods
                ? staticMethods
                : staticMethods
                    .addHashEntry(generateEncode(typeMap, fullName, message, options))
                    .addHashEntry(generateDecode(typeMap, fullName, message, options));
            staticMethods = !options.outputJsonMethods
                ? staticMethods
                : staticMethods
                    .addHashEntry(generateFromJson(typeMap, fullName, message, options))
                    .addHashEntry(generateFromPartial(typeMap, fullName, message, options))
                    .addHashEntry(generateToJson(typeMap, fullName, message, options));
            staticMethods = staticMethods
                .endHash()
                .add(';')
                .newLine();
            file = file.addCode(staticMethods);
        }, options);
    }
    visitServices(fileDesc, sourceInfo, (serviceDesc, sInfo) => {
        file = file.addInterface(generateService(typeMap, fileDesc, sInfo, serviceDesc, options));
        file = !options.outputClientImpl
            ? file
            : file.addClass(generateServiceClientImpl(typeMap, fileDesc, serviceDesc, options));
    });
    if (options.outputClientImpl && fileDesc.service.length > 0) {
        file = file.addInterface(generateRpcType(options));
        if (options.useContext) {
            file = file.addInterface(generateDataLoadersType(options));
        }
    }
    let hasAnyTimestamps = false;
    visit(fileDesc, sourceInfo, (_, messageType) => {
        hasAnyTimestamps = hasAnyTimestamps || sequency_1.asSequence(messageType.field).any(types_1.isTimestamp);
    }, options);
    if (hasAnyTimestamps) {
        file = addTimestampMethods(file, options);
    }
    const initialOutput = file.toString();
    // This `.includes(...)` is a pretty fuzzy way of detecting whether we use these utility
    // methods (to prevent outputting them if its not necessary). In theory, we should be able
    // to lean on the code generation library more to do this sort of "output only if used",
    // similar to what it does for auto-imports.
    if (initialOutput.includes('longToNumber') ||
        initialOutput.includes('numberToLong') ||
        initialOutput.includes('longToString')) {
        file = addLongUtilityMethod(file, options);
    }
    if (initialOutput.includes('DeepPartial')) {
        file = addDeepPartialType(file);
    }
    return file;
}
exports.generateFile = generateFile;
function addLongUtilityMethod(file, options) {
    if (options.forceLong === LongOption.LONG) {
        return file.addFunction(ts_poet_1.FunctionSpec.create('numberToLong')
            .addParameter('number', 'number')
            .addCodeBlock(ts_poet_1.CodeBlock.empty().addStatement('return %T.fromNumber(number)', 'Long*long')));
    }
    else if (options.forceLong === LongOption.STRING) {
        return file.addFunction(ts_poet_1.FunctionSpec.create('longToString')
            .addParameter('long', 'Long*long')
            .addCodeBlock(ts_poet_1.CodeBlock.empty().addStatement('return long.toString()')));
    }
    else {
        return file.addFunction(ts_poet_1.FunctionSpec.create('longToNumber')
            .addParameter('long', 'Long*long')
            .addCodeBlock(ts_poet_1.CodeBlock.empty()
            .beginControlFlow('if (long.gt(Number.MAX_SAFE_INTEGER))')
            .addStatement('throw new global.Error("Value is larger than Number.MAX_SAFE_INTEGER")')
            .endControlFlow()
            .addStatement('return long.toNumber()')));
    }
}
function addDeepPartialType(file) {
    return file.addCode(ts_poet_1.CodeBlock.empty()
        .add('type DeepPartial<T> = {%>\n')
        .add('[P in keyof T]?: T[P] extends Array<infer U>\n')
        .add('? Array<DeepPartial<U>>\n')
        .add(': T[P] extends ReadonlyArray<infer U>\n')
        .add('? ReadonlyArray<DeepPartial<U>>\n')
        .add(': T[P] extends Date | Function | Uint8Array | undefined\n')
        .add('? T[P]\n')
        .add(': T[P] extends infer U | undefined\n')
        .add('? DeepPartial<U>\n')
        .add(': T[P] extends object\n')
        .add('? DeepPartial<T[P]>\n')
        .add(': T[P]\n%<')
        .add('};'));
}
function addTimestampMethods(file, options) {
    const timestampType = 'Timestamp@./google/protobuf/timestamp';
    let secondsCodeLine = 'const seconds = date.getTime() / 1_000';
    let toNumberCode = 't.seconds';
    if (options.forceLong === LongOption.LONG) {
        toNumberCode = 't.seconds.toNumber()';
        secondsCodeLine = 'const seconds = numberToLong(date.getTime() / 1_000)';
    }
    else if (options.forceLong === LongOption.STRING) {
        toNumberCode = 'Number(t.seconds)';
        secondsCodeLine = 'const seconds = (date.getTime() / 1_000).toString()';
    }
    return file
        .addFunction(ts_poet_1.FunctionSpec.create('toTimestamp')
        .addParameter('date', 'Date')
        .returns(timestampType)
        .addCodeBlock(ts_poet_1.CodeBlock.empty()
        .addStatement(secondsCodeLine)
        .addStatement('const nanos = (date.getTime() %% 1_000) * 1_000_000')
        .addStatement('return { seconds, nanos }')))
        .addFunction(ts_poet_1.FunctionSpec.create('fromTimestamp')
        .addParameter('t', timestampType)
        .returns('Date')
        .addCodeBlock(ts_poet_1.CodeBlock.empty()
        .addStatement('let millis = %L * 1_000', toNumberCode)
        .addStatement('millis += t.nanos / 1_000_000')
        .addStatement('return new Date(millis)')))
        .addFunction(ts_poet_1.FunctionSpec.create('fromJsonTimestamp')
        .addParameter('o', 'any')
        .returns('Date')
        .addCodeBlock(ts_poet_1.CodeBlock.empty()
        .beginControlFlow('if (o instanceof Date)')
        .addStatement('return o')
        .nextControlFlow('else if (typeof o === "string")')
        .addStatement('return new Date(o)')
        .nextControlFlow('else')
        .addStatement('return fromTimestamp(Timestamp.fromJSON(o))')
        .endControlFlow()));
}
const UNRECOGNIZED_ENUM_NAME = "UNRECOGNIZED";
const UNRECOGNIZED_ENUM_VALUE = -1;
function generateEnum(options, fullName, enumDesc, sourceInfo) {
    let code = ts_poet_1.CodeBlock.empty();
    utils_1.maybeAddComment(sourceInfo, text => (code = code.add(`/** %L */\n`, text)));
    code = code.beginControlFlow('export const %L =', fullName);
    let index = 0;
    for (const valueDesc of enumDesc.value) {
        const info = sourceInfo.lookup(sourceInfo_1.Fields.enum.value, index++);
        utils_1.maybeAddComment(info, text => (code = code.add(`/** ${valueDesc.name} - ${text} */\n`)));
        code = code.add('%L: %L as %L,\n', valueDesc.name, valueDesc.number.toString(), fullName);
    }
    code = code.add('%L: %L as %L,\n', UNRECOGNIZED_ENUM_NAME, UNRECOGNIZED_ENUM_VALUE.toString(), fullName);
    if (options.outputJsonMethods) {
        code = code.addHashEntry(generateEnumFromJson(fullName, enumDesc));
        code = code.addHashEntry(generateEnumToJson(fullName, enumDesc));
    }
    code = code.endControlFlow();
    code = code.add('\n');
    const enumTypes = [...enumDesc.value.map(v => v.number.toString()), UNRECOGNIZED_ENUM_VALUE.toString()];
    code = code.add('export type %L = %L;', fullName, enumTypes.join(' | '));
    code = code.add('\n');
    return code;
}
function generateEnumFromJson(fullName, enumDesc) {
    let func = ts_poet_1.FunctionSpec.create('fromJSON')
        .addParameter('object', 'any')
        .returns(fullName);
    let body = ts_poet_1.CodeBlock.empty().beginControlFlow('switch (object)');
    for (const valueDesc of enumDesc.value) {
        body = body
            .add('case %L:\n', valueDesc.number)
            .add('case %S:%>\n', valueDesc.name)
            .addStatement('return %L.%L%<', fullName, valueDesc.name);
    }
    body = body
        .add('case %L:\n', UNRECOGNIZED_ENUM_VALUE)
        .add('case %S:\n', UNRECOGNIZED_ENUM_NAME)
        .add('default:%>\n')
        .addStatement('return %L.%L%<', fullName, UNRECOGNIZED_ENUM_NAME)
        .endControlFlow();
    return func.addCodeBlock(body);
}
function generateEnumToJson(fullName, enumDesc) {
    let func = ts_poet_1.FunctionSpec.create('toJSON')
        .addParameter('object', fullName)
        .returns('string');
    let body = ts_poet_1.CodeBlock.empty().beginControlFlow('switch (object)');
    for (const valueDesc of enumDesc.value) {
        body = body.add('case %L.%L:%>\n', fullName, valueDesc.name).addStatement('return %S%<', valueDesc.name);
    }
    body = body
        .add('default:%>\n')
        .addStatement('return "UNKNOWN"%<')
        .endControlFlow();
    return func.addCodeBlock(body);
}
// Create the interface with properties
function generateInterfaceDeclaration(typeMap, fullName, messageDesc, sourceInfo, options) {
    let message = ts_poet_1.InterfaceSpec.create(fullName).addModifiers(ts_poet_1.Modifier.EXPORT);
    utils_1.maybeAddComment(sourceInfo, text => (message = message.addJavadoc(text)));
    let index = 0;
    for (const fieldDesc of messageDesc.field) {
        let prop = ts_poet_1.PropertySpec.create(maybeSnakeToCamel(fieldDesc.name, options), types_1.toTypeName(typeMap, messageDesc, fieldDesc, options));
        const info = sourceInfo.lookup(sourceInfo_1.Fields.message.field, index++);
        utils_1.maybeAddComment(info, text => (prop = prop.addJavadoc(text)));
        message = message.addProperty(prop);
    }
    return message;
}
function generateBaseInstance(fullName, messageDesc, options) {
    // Create a 'base' instance with default values for decode to use as a prototype
    let baseMessage = ts_poet_1.PropertySpec.create('base' + fullName, ts_poet_1.TypeNames.anyType('object')).addModifiers(ts_poet_1.Modifier.CONST);
    let initialValue = ts_poet_1.CodeBlock.empty().beginHash();
    sequency_1.asSequence(messageDesc.field)
        .filterNot(types_1.isWithinOneOf)
        .forEach(field => {
        initialValue = initialValue.addHashEntry(maybeSnakeToCamel(field.name, options), types_1.defaultValue(field.type, options));
    });
    return baseMessage.initializerBlock(initialValue.endHash());
}
function visit(proto, sourceInfo, messageFn, options, enumFn = () => { }, tsPrefix = '', protoPrefix = '') {
    const isRootFile = proto instanceof FileDescriptorProto;
    const childEnumType = isRootFile ? sourceInfo_1.Fields.file.enum_type : sourceInfo_1.Fields.message.enum_type;
    let index = 0;
    for (const enumDesc of proto.enumType) {
        // I.e. Foo_Bar.Zaz_Inner
        const protoFullName = protoPrefix + enumDesc.name;
        // I.e. FooBar_ZazInner
        const tsFullName = tsPrefix + maybeSnakeToCamel(enumDesc.name, options);
        const nestedSourceInfo = sourceInfo.open(childEnumType, index++);
        enumFn(tsFullName, enumDesc, nestedSourceInfo, protoFullName);
    }
    const messages = proto instanceof FileDescriptorProto ? proto.messageType : proto.nestedType;
    const childType = isRootFile ? sourceInfo_1.Fields.file.message_type : sourceInfo_1.Fields.message.nested_type;
    index = 0;
    for (const message of messages) {
        // I.e. Foo_Bar.Zaz_Inner
        const protoFullName = protoPrefix + message.name;
        // I.e. FooBar_ZazInner
        const tsFullName = tsPrefix + maybeSnakeToCamel(message.name, options);
        const nestedSourceInfo = sourceInfo.open(childType, index++);
        messageFn(tsFullName, message, nestedSourceInfo, protoFullName);
        visit(message, nestedSourceInfo, messageFn, options, enumFn, tsFullName + '_', protoFullName + '.');
    }
}
exports.visit = visit;
function visitServices(proto, sourceInfo, serviceFn) {
    let index = 0;
    for (const serviceDesc of proto.service) {
        const nestedSourceInfo = sourceInfo.open(sourceInfo_1.Fields.file.service, index++);
        serviceFn(serviceDesc, nestedSourceInfo);
    }
}
/** Creates a function to decode a message by loop overing the tags. */
function generateDecode(typeMap, fullName, messageDesc, options) {
    // create the basic function declaration
    let func = ts_poet_1.FunctionSpec.create('decode')
        .addParameter('reader', 'Reader@protobufjs/minimal')
        .addParameter('length?', 'number')
        .returns(fullName);
    // add the initial end/message
    func = func
        .addStatement('let end = length === undefined ? reader.len : reader.pos + length')
        .addStatement('const message = Object.create(base%L) as %L', fullName, fullName);
    // initialize all lists
    messageDesc.field.filter(types_1.isRepeated).forEach(field => {
        const value = types_1.isMapType(typeMap, messageDesc, field, options) ? '{}' : '[]';
        func = func.addStatement('message.%L = %L', maybeSnakeToCamel(field.name, options), value);
    });
    // start the tag loop
    func = func
        .beginControlFlow('while (reader.pos < end)')
        .addStatement('const tag = reader.uint32()')
        .beginControlFlow('switch (tag >>> 3)');
    // add a case for each incoming field
    messageDesc.field.forEach(field => {
        const fieldName = maybeSnakeToCamel(field.name, options);
        func = func.addCode('case %L:%>\n', field.number);
        // get a generic 'reader.doSomething' bit that is specific to the basic type
        let readSnippet;
        if (types_1.isPrimitive(field)) {
            readSnippet = ts_poet_1.CodeBlock.of('reader.%L()', types_1.toReaderCall(field));
            if (types_1.basicLongWireType(field.type) !== undefined) {
                if (options.forceLong === LongOption.LONG) {
                    readSnippet = ts_poet_1.CodeBlock.of('%L as Long', readSnippet);
                }
                else if (options.forceLong === LongOption.STRING) {
                    readSnippet = ts_poet_1.CodeBlock.of('longToString(%L as Long)', readSnippet);
                }
                else {
                    readSnippet = ts_poet_1.CodeBlock.of('longToNumber(%L as Long)', readSnippet);
                }
            }
            else if (types_1.isEnum(field)) {
                readSnippet = readSnippet.add(' as any');
            }
        }
        else if (types_1.isValueType(field)) {
            readSnippet = ts_poet_1.CodeBlock.of('%T.decode(reader, reader.uint32()).value', types_1.basicTypeName(typeMap, field, options, true));
        }
        else if (types_1.isTimestamp(field)) {
            readSnippet = ts_poet_1.CodeBlock.of('fromTimestamp(%T.decode(reader, reader.uint32()))', types_1.basicTypeName(typeMap, field, options, true));
        }
        else if (types_1.isMessage(field)) {
            readSnippet = ts_poet_1.CodeBlock.of('%T.decode(reader, reader.uint32())', types_1.basicTypeName(typeMap, field, options));
        }
        else {
            throw new Error(`Unhandled field ${field}`);
        }
        // and then use the snippet to handle repeated fields if necessary
        if (types_1.isRepeated(field)) {
            if (types_1.isMapType(typeMap, messageDesc, field, options)) {
                // We need a unique const within the `cast` statement
                const entryVariableName = `entry${field.number}`;
                func = func
                    .addStatement(`const %L = %L`, entryVariableName, readSnippet)
                    .beginControlFlow('if (%L.value)', entryVariableName)
                    .addStatement('message.%L[%L.key] = %L.value', fieldName, entryVariableName, entryVariableName)
                    .endControlFlow();
            }
            else if (types_1.packedType(field.type) === undefined) {
                func = func.addStatement(`message.%L.push(%L)`, fieldName, readSnippet);
            }
            else {
                func = func
                    .beginControlFlow('if ((tag & 7) === 2)')
                    .addStatement('const end2 = reader.uint32() + reader.pos')
                    .beginControlFlow('while (reader.pos < end2)')
                    .addStatement(`message.%L.push(%L)`, fieldName, readSnippet)
                    .endControlFlow()
                    .nextControlFlow('else')
                    .addStatement(`message.%L.push(%L)`, fieldName, readSnippet)
                    .endControlFlow();
            }
        }
        else {
            func = func.addStatement(`message.%L = %L`, fieldName, readSnippet);
        }
        func = func.addStatement('break%<');
    });
    func = func
        .addCode('default:%>\n')
        .addStatement('reader.skipType(tag & 7)')
        .addStatement('break%<');
    // and then wrap up the switch/while/return
    func = func
        .endControlFlow()
        .endControlFlow()
        .addStatement('return message');
    return func;
}
/** Creates a function to encode a message by loop overing the tags. */
function generateEncode(typeMap, fullName, messageDesc, options) {
    // create the basic function declaration
    let func = ts_poet_1.FunctionSpec.create('encode')
        .addParameter('message', fullName)
        .addParameter('writer', 'Writer@protobufjs/minimal', { defaultValueField: ts_poet_1.CodeBlock.of('Writer.create()') })
        .returns('Writer@protobufjs/minimal');
    // then add a case for each field
    messageDesc.field.forEach(field => {
        const fieldName = maybeSnakeToCamel(field.name, options);
        // get a generic writer.doSomething based on the basic type
        let writeSnippet;
        if (types_1.isPrimitive(field)) {
            const tag = ((field.number << 3) | types_1.basicWireType(field.type)) >>> 0;
            writeSnippet = place => ts_poet_1.CodeBlock.of('writer.uint32(%L).%L(%L)', tag, types_1.toReaderCall(field), place);
        }
        else if (types_1.isTimestamp(field)) {
            const tag = ((field.number << 3) | 2) >>> 0;
            writeSnippet = place => ts_poet_1.CodeBlock.of('%T.encode(toTimestamp(%L), writer.uint32(%L).fork()).ldelim()', types_1.basicTypeName(typeMap, field, options, true), place, tag);
        }
        else if (types_1.isValueType(field)) {
            const tag = ((field.number << 3) | 2) >>> 0;
            writeSnippet = place => ts_poet_1.CodeBlock.of('%T.encode({ value: %L! }, writer.uint32(%L).fork()).ldelim()', types_1.basicTypeName(typeMap, field, options, true), place, tag);
        }
        else if (types_1.isMessage(field)) {
            const tag = ((field.number << 3) | 2) >>> 0;
            writeSnippet = place => ts_poet_1.CodeBlock.of('%T.encode(%L, writer.uint32(%L).fork()).ldelim()', types_1.basicTypeName(typeMap, field, options), place, tag);
        }
        else {
            throw new Error(`Unhandled field ${field}`);
        }
        if (types_1.isRepeated(field)) {
            if (types_1.isMapType(typeMap, messageDesc, field, options)) {
                func = func
                    .beginLambda('Object.entries(message.%L).forEach(([key, value]) =>', fieldName)
                    .addStatement('%L', writeSnippet('{ key: key as any, value }'))
                    .endLambda(')');
            }
            else if (types_1.packedType(field.type) === undefined) {
                func = func
                    .beginControlFlow('for (const v of message.%L)', fieldName)
                    .addStatement('%L', writeSnippet('v!'))
                    .endControlFlow();
            }
            else {
                const tag = ((field.number << 3) | 2) >>> 0;
                func = func
                    .addStatement('writer.uint32(%L).fork()', tag)
                    .beginControlFlow('for (const v of message.%L)', fieldName)
                    .addStatement('writer.%L(v)', types_1.toReaderCall(field))
                    .endControlFlow()
                    .addStatement('writer.ldelim()');
            }
        }
        else if (types_1.isWithinOneOf(field) || types_1.isMessage(field)) {
            func = func
                .beginControlFlow('if (message.%L !== undefined && message.%L !== %L)', fieldName, fieldName, types_1.defaultValue(field.type, options))
                .addStatement('%L', writeSnippet(`message.${fieldName}`))
                .endControlFlow();
        }
        else {
            func = func.addStatement('%L', writeSnippet(`message.${fieldName}`));
        }
    });
    return func.addStatement('return writer');
}
/**
 * Creates a function to decode a message from JSON.
 *
 * This is very similar to decode, we loop through looking for properties, with
 * a few special cases for https://developers.google.com/protocol-buffers/docs/proto3#json.
 * */
function generateFromJson(typeMap, fullName, messageDesc, options) {
    // create the basic function declaration
    let func = ts_poet_1.FunctionSpec.create('fromJSON')
        .addParameter('object', 'any')
        .returns(fullName);
    // create the message
    func = func.addStatement('const message = Object.create(base%L) as %L', fullName, fullName);
    // initialize all lists
    messageDesc.field.filter(types_1.isRepeated).forEach(field => {
        const value = types_1.isMapType(typeMap, messageDesc, field, options) ? '{}' : '[]';
        func = func.addStatement('message.%L = %L', maybeSnakeToCamel(field.name, options), value);
    });
    // add a check for each incoming field
    messageDesc.field.forEach(field => {
        const fieldName = maybeSnakeToCamel(field.name, options);
        // get a generic 'reader.doSomething' bit that is specific to the basic type
        const readSnippet = (from) => {
            if (types_1.isEnum(field)) {
                return ts_poet_1.CodeBlock.of('%T.fromJSON(%L)', types_1.basicTypeName(typeMap, field, options), from);
            }
            else if (types_1.isPrimitive(field)) {
                // Convert primitives using the String(value)/Number(value) cstr, except for bytes
                if (types_1.isBytes(field)) {
                    return ts_poet_1.CodeBlock.of('%L', from);
                }
                else if (types_1.isLong(field) && options.forceLong === LongOption.LONG) {
                    const cstr = capitalize(types_1.basicTypeName(typeMap, field, options, true).toString());
                    return ts_poet_1.CodeBlock.of('%L.fromString(%L)', cstr, from);
                }
                else {
                    const cstr = capitalize(types_1.basicTypeName(typeMap, field, options, true).toString());
                    return ts_poet_1.CodeBlock.of('%L(%L)', cstr, from);
                }
                // if (basicLongWireType(field.type) !== undefined) {
                //   readSnippet = CodeBlock.of('longToNumber(%L as Long)', readSnippet);
                // }
            }
            else if (types_1.isTimestamp(field)) {
                return ts_poet_1.CodeBlock.of('fromJsonTimestamp(%L)', from);
            }
            else if (types_1.isValueType(field)) {
                const cstr = capitalize(types_1.basicTypeName(typeMap, field, options, false).typeChoices[0].toString());
                return ts_poet_1.CodeBlock.of('%L(%L)', cstr, from);
            }
            else if (types_1.isMessage(field)) {
                if (types_1.isRepeated(field) && types_1.isMapType(typeMap, messageDesc, field, options)) {
                    const valueType = typeMap.get(field.typeName)[2].field[1];
                    if (types_1.isPrimitive(valueType)) {
                        const cstr = capitalize(types_1.basicTypeName(typeMap, FieldDescriptorProto.create({ type: valueType.type }), options).toString());
                        return ts_poet_1.CodeBlock.of('%L(%L)', cstr, from);
                    }
                    else {
                        return ts_poet_1.CodeBlock.of('%T.fromJSON(%L)', types_1.basicTypeName(typeMap, valueType, options).toString(), from);
                    }
                }
                else {
                    return ts_poet_1.CodeBlock.of('%T.fromJSON(%L)', types_1.basicTypeName(typeMap, field, options), from);
                }
            }
            else {
                throw new Error(`Unhandled field ${field}`);
            }
        };
        // and then use the snippet to handle repeated fields if necessary
        func = func.beginControlFlow('if (object.%L !== undefined && object.%L !== null)', fieldName, fieldName);
        if (types_1.isRepeated(field)) {
            if (types_1.isMapType(typeMap, messageDesc, field, options)) {
                func = func
                    .beginLambda('Object.entries(object.%L).forEach(([key, value]) =>', fieldName)
                    .addStatement(`message.%L[%L] = %L`, fieldName, maybeCastToNumber(typeMap, messageDesc, field, 'key', options), readSnippet('value'))
                    .endLambda(')');
            }
            else {
                func = func
                    .beginControlFlow('for (const e of object.%L)', fieldName)
                    .addStatement(`message.%L.push(%L)`, fieldName, readSnippet('e'))
                    .endControlFlow();
            }
        }
        else {
            func = func.addStatement(`message.%L = %L`, fieldName, readSnippet(`object.${fieldName}`));
        }
        // set the default value (TODO Support bytes)
        if (!types_1.isRepeated(field) && field.type !== FieldDescriptorProto.Type.TYPE_BYTES) {
            func = func.nextControlFlow('else');
            func = func.addStatement(`message.%L = %L`, fieldName, types_1.isWithinOneOf(field) ? 'undefined' : types_1.defaultValue(field.type, options));
        }
        func = func.endControlFlow();
    });
    // and then wrap up the switch/while/return
    func = func.addStatement('return message');
    return func;
}
function generateToJson(typeMap, fullName, messageDesc, options) {
    // create the basic function declaration
    let func = ts_poet_1.FunctionSpec.create('toJSON')
        .addParameter('message', fullName)
        .returns('unknown');
    func = func.addCodeBlock(ts_poet_1.CodeBlock.empty().addStatement('const obj: any = {}'));
    // then add a case for each field
    messageDesc.field.forEach(field => {
        const fieldName = maybeSnakeToCamel(field.name, options);
        const readSnippet = (from) => {
            if (types_1.isEnum(field)) {
                return ts_poet_1.CodeBlock.of('%T.toJSON(%L)', types_1.basicTypeName(typeMap, field, options), from);
            }
            else if (types_1.isTimestamp(field)) {
                return ts_poet_1.CodeBlock.of('%L !== undefined ? %L.toISOString() : null', from, from);
            }
            else if (types_1.isMessage(field) && !types_1.isValueType(field) && !types_1.isMapType(typeMap, messageDesc, field, options)) {
                return ts_poet_1.CodeBlock.of('%L ? %T.toJSON(%L) : %L', from, types_1.basicTypeName(typeMap, field, options, true), from, types_1.defaultValue(field.type, options));
            }
            else {
                if (types_1.isLong(field) && options.forceLong === LongOption.LONG) {
                    return ts_poet_1.CodeBlock.of('(%L || %L).toString()', from, types_1.isWithinOneOf(field) ? 'undefined' : types_1.defaultValue(field.type, options));
                }
                else {
                    return ts_poet_1.CodeBlock.of('%L || %L', from, types_1.isWithinOneOf(field) ? 'undefined' : types_1.defaultValue(field.type, options));
                }
            }
        };
        if (types_1.isRepeated(field) && !types_1.isMapType(typeMap, messageDesc, field, options)) {
            func = func
                .beginControlFlow('if (message.%L)', fieldName)
                .addStatement('obj.%L = message.%L.map(e => %L)', fieldName, fieldName, readSnippet('e'))
                .nextControlFlow('else')
                .addStatement('obj.%L = []', fieldName)
                .endControlFlow();
        }
        else {
            func = func.addStatement('obj.%L = %L', fieldName, readSnippet(`message.${fieldName}`));
        }
    });
    return func.addStatement('return obj');
}
function generateFromPartial(typeMap, fullName, messageDesc, options) {
    // create the basic function declaration
    let func = ts_poet_1.FunctionSpec.create('fromPartial')
        .addParameter('object', `DeepPartial<${fullName}>`)
        .returns(fullName);
    // create the message
    func = func.addStatement('const message = Object.create(base%L) as %L', fullName, fullName);
    // initialize all lists
    messageDesc.field.filter(types_1.isRepeated).forEach(field => {
        const value = types_1.isMapType(typeMap, messageDesc, field, options) ? '{}' : '[]';
        func = func.addStatement('message.%L = %L', maybeSnakeToCamel(field.name, options), value);
    });
    // add a check for each incoming field
    messageDesc.field.forEach(field => {
        const fieldName = maybeSnakeToCamel(field.name, options);
        const readSnippet = (from) => {
            if (types_1.isEnum(field) || types_1.isPrimitive(field) || types_1.isTimestamp(field) || types_1.isValueType(field)) {
                return ts_poet_1.CodeBlock.of(from);
            }
            else if (types_1.isMessage(field)) {
                if (types_1.isRepeated(field) && types_1.isMapType(typeMap, messageDesc, field, options)) {
                    const valueType = typeMap.get(field.typeName)[2].field[1];
                    if (types_1.isPrimitive(valueType)) {
                        const cstr = capitalize(types_1.basicTypeName(typeMap, FieldDescriptorProto.create({ type: valueType.type }), options).toString());
                        return ts_poet_1.CodeBlock.of('%L(%L)', cstr, from);
                    }
                    else {
                        return ts_poet_1.CodeBlock.of('%T.fromPartial(%L)', types_1.basicTypeName(typeMap, valueType, options).toString(), from);
                    }
                }
                else {
                    return ts_poet_1.CodeBlock.of('%T.fromPartial(%L)', types_1.basicTypeName(typeMap, field, options), from);
                }
            }
            else {
                throw new Error(`Unhandled field ${field}`);
            }
        };
        // and then use the snippet to handle repeated fields if necessary
        func = func.beginControlFlow('if (object.%L !== undefined && object.%L !== null)', fieldName, fieldName);
        if (types_1.isRepeated(field)) {
            if (types_1.isMapType(typeMap, messageDesc, field, options)) {
                func = func
                    .beginLambda('Object.entries(object.%L).forEach(([key, value]) =>', fieldName)
                    .beginControlFlow('if (value)')
                    .addStatement(`message.%L[%L] = %L`, fieldName, maybeCastToNumber(typeMap, messageDesc, field, 'key', options), readSnippet('value'))
                    .endControlFlow()
                    .endLambda(')');
            }
            else {
                func = func
                    .beginControlFlow('for (const e of object.%L)', fieldName)
                    .addStatement(`message.%L.push(%L)`, fieldName, readSnippet('e'))
                    .endControlFlow();
            }
        }
        else {
            if (types_1.isLong(field) && options.forceLong === LongOption.LONG) {
                func = func.addStatement(`message.%L = %L as %L`, fieldName, readSnippet(`object.${fieldName}`), types_1.basicTypeName(typeMap, field, options));
            }
            else {
                func = func.addStatement(`message.%L = %L`, fieldName, readSnippet(`object.${fieldName}`));
            }
        }
        // set the default value (TODO Support bytes)
        if (!types_1.isRepeated(field) && field.type !== FieldDescriptorProto.Type.TYPE_BYTES) {
            func = func.nextControlFlow('else');
            func = func.addStatement(`message.%L = %L`, fieldName, types_1.isWithinOneOf(field) ? 'undefined' : types_1.defaultValue(field.type, options));
        }
        func = func.endControlFlow();
    });
    // and then wrap up the switch/while/return
    return func.addStatement('return message');
}
const contextTypeVar = ts_poet_1.TypeNames.typeVariable('Context', ts_poet_1.TypeNames.bound('DataLoaders'));
function generateService(typeMap, fileDesc, sourceInfo, serviceDesc, options) {
    let service = ts_poet_1.InterfaceSpec.create(serviceDesc.name).addModifiers(ts_poet_1.Modifier.EXPORT);
    if (options.useContext) {
        service = service.addTypeVariable(contextTypeVar);
    }
    utils_1.maybeAddComment(sourceInfo, text => (service = service.addJavadoc(text)));
    let index = 0;
    for (const methodDesc of serviceDesc.method) {
        let requestFn = ts_poet_1.FunctionSpec.create(methodDesc.name);
        if (options.useContext) {
            requestFn = requestFn.addParameter('ctx', ts_poet_1.TypeNames.typeVariable('Context'));
        }
        const info = sourceInfo.lookup(sourceInfo_1.Fields.service.method, index++);
        utils_1.maybeAddComment(info, text => (requestFn = requestFn.addJavadoc(text)));
        requestFn = requestFn.addParameter('request', requestType(typeMap, methodDesc));
        requestFn = requestFn.returns(responsePromise(typeMap, methodDesc));
        service = service.addFunction(requestFn);
        if (options.useContext) {
            const batchMethod = detectBatchMethod(typeMap, fileDesc, serviceDesc, methodDesc, options);
            if (batchMethod) {
                const name = batchMethod.methodDesc.name.replace('Batch', 'Get');
                let batchFn = ts_poet_1.FunctionSpec.create(name);
                if (options.useContext) {
                    batchFn = batchFn.addParameter('ctx', ts_poet_1.TypeNames.typeVariable('Context'));
                }
                batchFn = batchFn.addParameter(utils_1.singular(batchMethod.inputFieldName), batchMethod.inputType);
                batchFn = batchFn.returns(ts_poet_1.TypeNames.PROMISE.param(batchMethod.outputType));
                service = service.addFunction(batchFn);
            }
        }
    }
    return service;
}
function hasSingleRepeatedField(messageDesc) {
    return messageDesc.field.length == 1 && messageDesc.field[0].label === FieldDescriptorProto.Label.LABEL_REPEATED;
}
function generateRegularRpcMethod(options, typeMap, fileDesc, serviceDesc, methodDesc) {
    let requestFn = ts_poet_1.FunctionSpec.create(methodDesc.name);
    if (options.useContext) {
        requestFn = requestFn.addParameter('ctx', ts_poet_1.TypeNames.typeVariable('Context'));
    }
    return requestFn
        .addParameter('request', requestType(typeMap, methodDesc))
        .addStatement('const data = %L.encode(request).finish()', requestType(typeMap, methodDesc))
        .addStatement('const promise = this.rpc.request(%L"%L.%L", %S, %L)', options.useContext ? 'ctx, ' : '', // sneak ctx in as the 1st parameter to our rpc call
    fileDesc.package, serviceDesc.name, methodDesc.name, 'data')
        .addStatement('return promise.then(data => %L.decode(new %T(data)))', responseType(typeMap, methodDesc), 'Reader@protobufjs/minimal')
        .returns(responsePromise(typeMap, methodDesc));
}
function generateServiceClientImpl(typeMap, fileDesc, serviceDesc, options) {
    // Define the FooServiceImpl class
    let client = ts_poet_1.ClassSpec.create(`${serviceDesc.name}ClientImpl`).addModifiers(ts_poet_1.Modifier.EXPORT);
    if (options.useContext) {
        client = client.addTypeVariable(contextTypeVar);
        client = client.addInterface(`${serviceDesc.name}<Context>`);
    }
    else {
        client = client.addInterface(serviceDesc.name);
    }
    // Create the constructor(rpc: Rpc)
    const rpcType = options.useContext ? 'Rpc<Context>' : 'Rpc';
    client = client.addFunction(ts_poet_1.FunctionSpec.createConstructor()
        .addParameter('rpc', rpcType)
        .addStatement('this.rpc = rpc'));
    client = client.addProperty('rpc', rpcType, { modifiers: [ts_poet_1.Modifier.PRIVATE, ts_poet_1.Modifier.READONLY] });
    // Create a method for each FooService method
    for (const methodDesc of serviceDesc.method) {
        // See if this this fuzzy matches to a batchable method
        if (options.useContext) {
            const batchMethod = detectBatchMethod(typeMap, fileDesc, serviceDesc, methodDesc, options);
            if (batchMethod) {
                client = client.addFunction(generateBatchingRpcMethod(typeMap, batchMethod));
            }
        }
        if (options.useContext && methodDesc.name.match(/^Get[A-Z]/)) {
            client = client.addFunction(generateCachingRpcMethod(options, typeMap, fileDesc, serviceDesc, methodDesc));
        }
        else {
            client = client.addFunction(generateRegularRpcMethod(options, typeMap, fileDesc, serviceDesc, methodDesc));
        }
    }
    return client;
}
function detectBatchMethod(typeMap, fileDesc, serviceDesc, methodDesc, options) {
    const nameMatches = methodDesc.name.startsWith('Batch');
    const inputType = typeMap.get(methodDesc.inputType);
    const outputType = typeMap.get(methodDesc.outputType);
    if (nameMatches && inputType && outputType) {
        // TODO: This might be enums?
        const inputTypeDesc = inputType[2];
        const outputTypeDesc = outputType[2];
        if (hasSingleRepeatedField(inputTypeDesc) && hasSingleRepeatedField(outputTypeDesc)) {
            const singleMethodName = methodDesc.name.replace('Batch', 'Get');
            const inputFieldName = inputTypeDesc.field[0].name;
            const inputType = types_1.basicTypeName(typeMap, inputTypeDesc.field[0], options); // e.g. repeated string -> string
            const outputFieldName = outputTypeDesc.field[0].name;
            let outputType = types_1.basicTypeName(typeMap, outputTypeDesc.field[0], options); // e.g. repeated Entity -> Entity
            const mapType = types_1.detectMapType(typeMap, outputTypeDesc, outputTypeDesc.field[0], options);
            if (mapType) {
                outputType = mapType.valueType;
            }
            const uniqueIdentifier = `${fileDesc.package}.${serviceDesc.name}.${methodDesc.name}`;
            return {
                methodDesc,
                uniqueIdentifier,
                singleMethodName,
                inputFieldName,
                inputType,
                outputFieldName,
                outputType,
                mapType: !!mapType
            };
        }
    }
    return undefined;
}
/** We've found a BatchXxx method, create a synthetic GetXxx method that calls it. */
function generateBatchingRpcMethod(typeMap, batchMethod) {
    const { methodDesc, singleMethodName, inputFieldName, inputType, outputFieldName, outputType, mapType, uniqueIdentifier } = batchMethod;
    // Create the `(keys) => ...` lambda we'll pass to the DataLoader constructor
    let lambda = ts_poet_1.CodeBlock.lambda(inputFieldName) // e.g. keys
        .addStatement('const request = { %L }', inputFieldName);
    if (mapType) {
        // If the return type is a map, lookup each key in the result
        lambda = lambda
            .beginLambda('return this.%L(ctx, request).then(res =>', methodDesc.name)
            .addStatement('return %L.map(key => res.%L[key])', inputFieldName, outputFieldName)
            .endLambda(')');
    }
    else {
        // Otherwise assume they come back in order
        lambda = lambda.addStatement('return this.%L(ctx, request).then(res => res.%L)', methodDesc.name, outputFieldName);
    }
    return ts_poet_1.FunctionSpec.create(singleMethodName)
        .addParameter('ctx', 'Context')
        .addParameter(utils_1.singular(inputFieldName), inputType)
        .addCode('const dl = ctx.getDataLoader(%S, () => {%>\n', uniqueIdentifier)
        .addCode('return new %T<%T, %T>(%L, { cacheKeyFn: %T, ...ctx.rpcDataLoaderOptions });\n', dataloader, inputType, outputType, lambda, ts_poet_1.TypeNames.anyType('hash*object-hash'))
        .addCode('%<});\n')
        .addStatement('return dl.load(%L)', utils_1.singular(inputFieldName))
        .returns(ts_poet_1.TypeNames.PROMISE.param(outputType));
}
/** We're not going to batch, but use DataLoader for per-request caching. */
function generateCachingRpcMethod(options, typeMap, fileDesc, serviceDesc, methodDesc) {
    const inputType = requestType(typeMap, methodDesc);
    const outputType = responseType(typeMap, methodDesc);
    let lambda = ts_poet_1.CodeBlock.lambda('requests')
        .beginLambda('const responses = requests.map(async request =>')
        .addStatement('const data = %L.encode(request).finish()', inputType)
        .addStatement('const response = await this.rpc.request(ctx, "%L.%L", %S, %L)', fileDesc.package, serviceDesc.name, methodDesc.name, 'data')
        .addStatement('return %L.decode(new %T(response))', responseType(typeMap, methodDesc), 'Reader@protobufjs/minimal')
        .endLambda(')')
        .addStatement('return Promise.all(responses)');
    const uniqueIdentifier = `${fileDesc.package}.${serviceDesc.name}.${methodDesc.name}`;
    return ts_poet_1.FunctionSpec.create(methodDesc.name)
        .addParameter('ctx', 'Context')
        .addParameter('request', requestType(typeMap, methodDesc))
        .addCode('const dl = ctx.getDataLoader(%S, () => {%>\n', uniqueIdentifier)
        .addCode('return new %T<%T, %T>(%L, { cacheKeyFn: %T, ...ctx.rpcDataLoaderOptions });\n', dataloader, inputType, outputType, lambda, ts_poet_1.TypeNames.anyType('hash*object-hash'))
        .addCode('%<});\n')
        .addStatement('return dl.load(request)')
        .returns(ts_poet_1.TypeNames.PROMISE.param(outputType));
}
/**
 * Creates an `Rpc.request(service, method, data)` abstraction.
 *
 * This lets clients pass in their own request-promise-ish client.
 *
 * We don't export this because if a project uses multiple `*.proto` files,
 * we don't want our the barrel imports in `index.ts` to have multiple `Rpc`
 * types.
 */
function generateRpcType(options) {
    const data = ts_poet_1.TypeNames.anyType('Uint8Array');
    let fn = ts_poet_1.FunctionSpec.create('request');
    if (options.useContext) {
        fn = fn.addParameter('ctx', 'Context');
    }
    fn = fn
        .addParameter('service', ts_poet_1.TypeNames.STRING)
        .addParameter('method', ts_poet_1.TypeNames.STRING)
        .addParameter('data', data)
        .returns(ts_poet_1.TypeNames.PROMISE.param(data));
    let rpc = ts_poet_1.InterfaceSpec.create('Rpc');
    if (options.useContext) {
        rpc = rpc.addTypeVariable(ts_poet_1.TypeNames.typeVariable('Context'));
    }
    rpc = rpc.addFunction(fn);
    return rpc;
}
function generateDataLoadersType(options) {
    // TODO Maybe should be a generic `Context.get<T>(id, () => T): T` method
    let fn = ts_poet_1.FunctionSpec.create('getDataLoader')
        .addTypeVariable(ts_poet_1.TypeNames.typeVariable('T'))
        .addParameter('identifier', ts_poet_1.TypeNames.STRING)
        .addParameter('constructorFn', ts_poet_1.TypeNames.lambda2([], ts_poet_1.TypeNames.typeVariable('T')))
        .returns(ts_poet_1.TypeNames.typeVariable('T'));
    return ts_poet_1.InterfaceSpec.create('DataLoaders')
        .addModifiers(ts_poet_1.Modifier.EXPORT)
        .addFunction(fn);
}
function requestType(typeMap, methodDesc) {
    return types_1.messageToTypeName(typeMap, methodDesc.inputType);
}
function responseType(typeMap, methodDesc) {
    return types_1.messageToTypeName(typeMap, methodDesc.outputType);
}
function responsePromise(typeMap, methodDesc) {
    return ts_poet_1.TypeNames.PROMISE.param(responseType(typeMap, methodDesc));
}
// function generateOneOfProperty(typeMap: TypeMap, name: string, fields: FieldDescriptorProto[]): PropertySpec {
//   const adtType = TypeNames.unionType(
//     ...fields.map(f => {
//       const kind = new Member('field', TypeNames.anyType(`'${f.name}'`), false);
//       const value = new Member('value', toTypeName(typeMap, f), false);
//       return TypeNames.anonymousType(kind, value);
//     })
//   );
//   return PropertySpec.create(snakeToCamel(name), adtType);
// }
function maybeSnakeToCamel(s, options) {
    if (options.snakeToCamel) {
        return s.replace(/(\_\w)/g, m => m[1].toUpperCase());
    }
    else {
        return s;
    }
}
function capitalize(s) {
    return s.substring(0, 1).toUpperCase() + s.substring(1);
}
function maybeCastToNumber(typeMap, messageDesc, field, variableName, options) {
    const { keyType } = types_1.detectMapType(typeMap, messageDesc, field, options);
    if (keyType === ts_poet_1.TypeNames.STRING) {
        return variableName;
    }
    else {
        return `Number(${variableName})`;
    }
}
